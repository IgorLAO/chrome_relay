# Chrome Relay — Documentação Técnica

Servidor de *browser remoto*: roda um Chromium headless no servidor, captura o que ele desenha como JPEG, transmite os frames por WebSocket para um cliente React, e envia de volta os eventos de mouse/teclado/scroll do usuário. Cada cliente conectado recebe sua própria aba isolada.

---

## 1. Visão geral da arquitetura

```
┌────────────────────────┐   WSS (binário JPEG + JSON)   ┌────────────────────────┐
│   Navegador do usuário │ ◄────────────────────────────►│  Servidor Bun (Node)   │
│   React + <canvas>     │                               │  src/index.ts          │
└────────────────────────┘                               └─────────┬──────────────┘
                                                                   │ Puppeteer
                                                                   │ (CDP via pipe/WS)
                                                          ┌────────▼─────────┐
                                                          │ Chromium headless│
                                                          │ 1 page por sessão│
                                                          └──────────────────┘
```

Componentes:

| Camada | Tecnologia | Pasta |
|--------|------------|-------|
| Cliente (UI) | React 19 + Vite + TypeScript | `app/` |
| Bundle servido | HTML estático compilado | `public/` (gerado pelo `vite build`) |
| Servidor | Bun + `ws` + Puppeteer | `src/` |
| Browser | Chromium headless do Alpine | embarcado no Dockerfile |
| Borda (produção) | Traefik com Basic Auth + Let's Encrypt | `compose.yml` |

---

## 2. Estrutura de arquivos

```
src/
├── index.ts        ← bootstrap: HTTP, HTTPS, WSS, ciclo de vida da conexão
├── browser.ts      ← lança o Chromium headless via Puppeteer
├── session.ts      ← cria 1 aba (page) por WebSocket, inicia screencast CDP
├── handler.ts      ← roteia mensagens JSON do cliente → CDP/Puppeteer
├── download.ts     ← intercepta downloads e os reenvia em base64
└── static.ts       ← serve os arquivos da pasta public/ (com SPA fallback)

app/
├── index.html      ← shell montado pelo Vite
├── vite.config.ts  ← outDir aponta para ../public
└── src/
    ├── main.tsx              ← createRoot + <App />
    ├── App.tsx               ← barra de URL, WebSocket, estado da UI
    ├── components/canvas.tsx ← captura mouse/teclado e desenha frames
    └── utils/index.ts        ← BUTTONS, KEY_MAP, drawJpegFrame, etc.
```

---

## 3. Inicialização do servidor (`src/index.ts`)

Sequência do `main()`:

1. `connectToBrowser()` — sobe o Chromium **uma única vez** e mantém vivo.
2. Lê `key.pem` / `cert.pem` (paths configuráveis por `SSL_KEY` / `SSL_CERT`).
3. Cria `httpServer` (porta 3050) e `httpsServer` (porta 3051), ambos servindo arquivos estáticos.
4. Monta um `WebSocketServer` em `path: '/ws'` em cima de **cada** servidor (HTTP e HTTPS), com `perMessageDeflate: false` para não comprimir os JPEGs (que já estão comprimidos).
5. A cada `connection`, chama `createSession(browser, ws)` — abre uma aba dedicada — e instala `onMessage` e `onClose`.

Por que dois servidores? Para permitir acesso via `ws://` em desenvolvimento local e `wss://` quando atrás do Traefik (que termina TLS na borda).

> Documentação `ws`: <https://github.com/websockets/ws/blob/master/doc/ws.md#class-websocketserver>

---

## 4. Conexão com o Chromium (`src/browser.ts`)

```ts
puppeteer.launch({ executablePath: CHROMIUM_PATH, headless: true, args: [...] })
```

Flags importantes (e *por que*):

| Flag | Motivo |
|------|--------|
| `--no-sandbox` | Roda em container sem capabilities extras. |
| `--disable-dev-shm-usage` | `/dev/shm` é minúsculo no Docker; sem isso o Chromium crasha. |
| `--disable-background-timer-throttling` | Sem isso, abas em background freezam → cada novo usuário derruba quem já estava conectado. |
| `--disable-backgrounding-occluded-windows` | Mesmo motivo: evita que tabs ocultas parem de renderizar. |
| `--disable-renderer-backgrounding` | Mantém o renderer ativo. |

> Puppeteer `launch`: <https://pptr.dev/api/puppeteer.puppeteernode.launch>
> Lista de flags do Chromium: <https://peter.sh/experiments/chromium-command-line-switches/>

---

## 5. Sessão por usuário (`src/session.ts`)

**Cada WebSocket recebe sua própria `Page` (aba) e seu próprio `CDPSession`.** É o que permite isolar usuários — eles compartilham o mesmo *processo* Chromium, mas não o mesmo contexto de navegação.

Passo a passo de `createSession(browser, ws)`:

1. **`browser.newPage()`** — cria uma nova aba.
2. **`page.setViewport({ width: FRAME_W, height: FRAME_H })`** — define resolução inicial (depois pode ser sobrescrita pelo `resize` do cliente).
3. **`page.createCDPSession()`** — abre um canal CDP direto (Chrome DevTools Protocol) para essa aba. É o que dá acesso a comandos de baixo nível como `Page.startScreencast` e `Input.dispatchMouseEvent`.
4. **`Emulation.setFocusEmulationEnabled` + `Page.setWebLifecycleState: active`** — fingem para a página que ela está sempre em foco e ativa. Sem isso, abas em background param de processar timers/animações.
   - Não usamos `page.bringToFront()` porque ele move o foco *real* para essa aba, derrubando o screencast de todas as outras.
5. **Diretório de downloads exclusivo** — `/tmp/chrome_relay_downloads/<uuid>` (UUID v4 do `crypto.randomUUID()`).
6. **`Page.startScreencast`** — pede ao CDP para começar a emitir eventos `Page.screencastFrame` com o JPEG da viewport (`format: 'jpeg', quality: 70, everyNthFrame: 1`).
7. Listener `cdp.on('Page.screencastFrame', ...)`:
   - Acka o frame com `Page.screencastFrameAck` (sem isso o Chromium para de emitir novos).
   - Decodifica `frame.data` (base64) para `Buffer` e envia pelo WebSocket como mensagem **binária**.
8. Listeners do Puppeteer:
   - `framenavigated` (apenas main frame) → manda `{ t: 'url', url }` para o cliente atualizar a barra.
   - `domcontentloaded` → manda `{ t: 'title', title }` para atualizar `document.title`.
9. `page.goto(DEFAULT_URL)` — carrega a página inicial.
10. Retorna `{ page, cdp, stop }` — o `stop` cancela o screencast e limpa downloads.

> CDP `Page.startScreencast`: <https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreencast>
> CDP `Page.screencastFrame`: <https://chromedevtools.github.io/devtools-protocol/tot/Page/#event-screencastFrame>
> Puppeteer `createCDPSession`: <https://pptr.dev/api/puppeteer.page.createcdpsession>

---

## 6. Roteamento de mensagens do cliente (`src/handler.ts`)

`makeMessageHandler(page, cdp, ws)` retorna um handler `(raw) => void` que faz `JSON.parse` e despacha por `msg.t`:

| `t` | Ação no servidor |
|-----|------------------|
| `nav` | `page.goto(url, { waitUntil: 'domcontentloaded' })` (prefixa `https://` se faltar). |
| `back` / `fwd` / `reload` | `page.goBack()` / `goForward()` / `reload()`. |
| `ping` | Devolve `{ "t": "pong" }` imediatamente — usado para medir RTT. |
| `resize` | **Debounced**: a primeira chamada é imediata, as subsequentes esperam 150 ms. Faz `page.setViewport({ w, h })`. |
| `mouse` | `cdp.send('Input.dispatchMouseEvent', msg.d)` — `msg.d` já vem com a estrutura do CDP. |
| `wheel` | `Input.dispatchMouseEvent` com `type: 'mouseWheel'`. |
| `keydown` | `Input.dispatchKeyEvent { type: 'keyDown' }`. Depois, **se** for caractere imprimível **e não** for atalho com Ctrl/Meta, dispara também `{ type: 'char', text }`. |
| `keyup` | `Input.dispatchKeyEvent { type: 'keyUp' }`. |

A ressalva sobre `char` é fundamental: sem o filtro de Ctrl/Meta, `Ctrl+C` digitaria a letra "c" em vez de copiar.

> CDP `Input.dispatchMouseEvent`: <https://chromedevtools.github.io/devtools-protocol/tot/Input/#method-dispatchMouseEvent>
> CDP `Input.dispatchKeyEvent`: <https://chromedevtools.github.io/devtools-protocol/tot/Input/#method-dispatchKeyEvent>

---

## 7. Downloads (`src/download.ts`)

O fluxo é:

1. `Page.setDownloadBehavior { behavior: 'allow', downloadPath: sessionDir }` — direciona downloads para o dir único da sessão.
2. `Page.downloadWillBegin` → guarda `guid → suggestedFilename` em um `Map`, e avisa o cliente: `{ t: 'download_start', filename }`.
3. `Page.downloadProgress` (state `completed`) → lê o arquivo do disco, codifica em base64 e envia: `{ t: 'download_ready', filename, data }`. Em seguida `unlink` para liberar disco.
4. Quando a sessão fecha, o `cleanupDownloads` apaga o diretório.

No cliente, `triggerBase64Download` cria um `<a download>` invisível e clica nele — o navegador do usuário recebe o arquivo como se tivesse sido baixado por ele.

> CDP `Page.setDownloadBehavior`: <https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-setDownloadBehavior>

---

## 8. Servidor estático (`src/static.ts`)

Função única `serveStatic(req, res)`:

- Resolve `req.url` contra `staticDir = ../public`.
- **Path traversal guard**: confere que o caminho resolvido começa com `staticDir + sep`; senão, `403`.
- Retorna o arquivo com o MIME correspondente (apenas `.html`, `.js`, `.css` mapeados; resto vira `application/octet-stream`).
- **SPA fallback**: se o arquivo pedido não existe, serve `index.html` — é o que permite o React Router (caso seja adicionado depois) funcionar.

---

## 9. Cliente React (`app/`)

### 9.1 `App.tsx` — orquestrador

Mantém estado de UI e o ciclo de vida do WebSocket:

- **Refs**: `canvasRef` (o `<canvas>`), `viewportRef` (o `<div>` que o contém para medir tamanho), `wsRef` (a conexão).
- **State**: `connected`, `overlayMsg`, `urlValue`, `pingText`, `dlBanner`.
- **`useEffect` #1 — WebSocket lifecycle**:
  - `connect()` cria `new WebSocket(\`${proto}//${location.host}/ws\`)` (proto = `wss:` se a página é HTTPS).
  - `binaryType = 'arraybuffer'` para receber JPEG como `ArrayBuffer`.
  - `onopen` → mede a viewport e manda `{ t: 'resize', w, h }` antes do primeiro frame.
  - `onmessage` → se for binário, chama `drawJpegFrame`; se for string, faz `JSON.parse` e despacha por `msg.t` (url, title, pong, download_start, download_ready).
  - `onclose` → marca desconectado e tenta reconectar a cada 2 s.
- **`useEffect` #2 — Ping**: a cada 5 s manda `{ t: 'ping' }` com timestamp guardado em `pingTime.current`. O `pong` calcula RTT.
- **`useEffect` #3 — `ResizeObserver`**: detecta mudança no `<div id="viewport">`, ajusta `canvas.width/height` e manda novo `resize`.
- **`useEffect` #4 — Paste fallback**: quando o usuário cola texto fora do canvas (ex.: na barra de URL), intercepta e converte em sequência de `keydown` para o servidor (útil quando o foco "real" está num `<input>` controlado pelo React).

### 9.2 `components/canvas.tsx` — entrada/saída de eventos

Anexa listeners no `<canvas>`:

- `mousemove` → throttle a ~60 fps (16 ms) e envia `mouseMoved` em coordenadas **da viewport do Chromium** (escaladas).
- `mousedown` / `mouseup` → calcula `clickCount` (1 ou 2) baseado em distância (<4 px) + tempo (<500 ms) desde o último clique → habilita double-click.
- `wheel` → envia `dx`, `dy` brutos.
- `keydown` / `keyup` → ignora `F12` e `Ctrl+Shift+I` (libera o DevTools local). Calcula `windowsVirtualKeyCode` via `KEY_MAP` ou `charCodeAt`.

Função `scaleCoords`: o `<canvas>` na tela tem tamanho CSS diferente do seu `width/height` interno; multiplica pela razão `canvas.width / rect.width` para mapear coordenadas da página para coordenadas que o CDP entende.

### 9.3 `utils/index.ts`

- `BUTTONS` — mapa do `MouseEvent.button` (0..4) para os nomes que o CDP espera.
- `KEY_MAP` + `getVirtualKeyCode` — converte `KeyboardEvent.key` para o virtual key code do Windows (que o CDP reaproveita).
- `getMods` — converte os 4 flags (`alt/ctrl/meta/shift`) na bitmask 1/2/4/8 do CDP.
- `drawJpegFrame` — `createImageBitmap(blob).then(drawImage)`. `createImageBitmap` é decodificado fora da main thread, evitando jank. O `bitmap.close()` libera a memória da GPU.
- `triggerBase64Download` — base64 → `Blob` → `URL.createObjectURL` → clique sintético em um `<a download>`.
- `textToKeydownMessages` — usado pelo paste fallback.

> `createImageBitmap`: <https://developer.mozilla.org/en-US/docs/Web/API/createImageBitmap>
> `ResizeObserver`: <https://developer.mozilla.org/en-US/docs/Web/API/ResizeObserver>
> `WebSocket.binaryType`: <https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/binaryType>

---

## 9.4 Como o React funciona neste projeto (em profundidade)

O cliente é um **SPA React 19** servido como bundle estático. Ele não faz SSR, não usa router, e tem **uma única árvore de componentes**: `<App />` → `<Canvas />`. Toda a "tela" do navegador remoto é, na verdade, **um `<canvas>`** desenhado por JS — o React só cuida da casca em volta (barra de URL, overlay de "conectando", banner de download).

### 9.4.1 Bootstrap

`app/index.html`:
```html
<div id="root"></div>
<script type="module" src="/src/main.tsx"></script>
```

`main.tsx`:
```tsx
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
```

- `createRoot` é a API do React 18+ para o **concurrent renderer**. Substitui o antigo `ReactDOM.render`.
- `<StrictMode>` em desenvolvimento **invoca cada `useEffect` duas vezes** (mount → unmount → mount) para detectar efeitos não idempotentes. Por isso, todo `useEffect` em `App.tsx` precisa ter cleanup correto (`return () => ws.close()`, `clearInterval`, etc.) — sem isso teríamos duas conexões WebSocket abertas em dev.

> `createRoot`: <https://react.dev/reference/react-dom/client/createRoot>
> `StrictMode`: <https://react.dev/reference/react/StrictMode>

### 9.4.2 Por que um único componente segura tudo

A regra geral em React é: **estado vive o mais perto possível de quem o usa, mas o mais alto possível de quem precisa compartilhá-lo**. Aqui, quem precisa do WebSocket é:
- A barra de URL (recebe `url` e `title`).
- O canvas (envia eventos de input).
- O overlay (mostra "Reconnecting…").
- O banner de download.

Como tudo está sob `<App />`, o WebSocket vive em `App.tsx` via `useRef`, e a função `send` é passada como prop para `<Canvas />`. Não tem Redux nem Context — não precisa.

### 9.4.3 `useRef` vs `useState` — quando cada um

A escolha aqui é deliberada e vale entender:

| Dado | Hook | Por quê |
|------|------|---------|
| `connected`, `urlValue`, `pingText`, `dlBanner`, `overlayMsg` | `useState` | A UI **muda visualmente** quando esses valores mudam → precisa de re-render. |
| `wsRef`, `canvasRef`, `viewportRef`, `vpW`, `vpH`, `pingTime`, `dlTimer` | `useRef` | São objetos mutáveis que **não devem disparar re-render** quando mudam. Se `wsRef` fosse state, cada mensagem WebSocket re-renderizaria todo o app. |

`useRef({}).current` é basicamente uma "caixa" persistente entre renders. O React garante que o objeto retornado é o **mesmo** entre renders — diferente de uma variável local, que é recriada a cada render.

> `useRef`: <https://react.dev/reference/react/useRef>
> `useState`: <https://react.dev/reference/react/useState>

### 9.4.4 Os quatro `useEffect` de `App.tsx` — anatomia

`useEffect(callback, deps)` roda **depois** do React commitar o DOM. O array de deps controla quando rodar de novo. Cleanup roda antes da próxima execução **e** no unmount.

#### Effect 1 — WebSocket lifecycle (`deps: []`)

`deps: []` significa "rode uma vez no mount, faça cleanup no unmount". A `connect()` interna é uma função recursiva: o `onclose` agenda `setTimeout(connect, 2000)`, então a reconexão é automática. A flag `destroyed` (capturada por closure) garante que, se o componente desmontar enquanto o `setTimeout` ainda está pendente, a próxima `connect()` não dispara.

A regra `eslint-disable-next-line react-hooks/exhaustive-deps` está lá porque `send` é usado dentro mas intencionalmente *não* é dependência — a gente não quer reabrir o WebSocket toda vez que `send` mudar de identidade.

#### Effect 2 — Ping (`deps: [send]`)

A cada 5 s, manda `{ t: 'ping' }`. `send` é estável porque é criada com `useCallback(..., [])`, então o efeito **não** vai realmente reexecutar — mas declarar a dep deixa o ESLint feliz e blinda contra refatorações futuras.

#### Effect 3 — `ResizeObserver` (`deps: [send]`)

Observa mudanças de tamanho do `<div id="viewport">` com a API `ResizeObserver` (não é React, é DOM puro). Quando o tamanho muda, atualiza `canvas.width/height` (que **não** vão pelo React — é manipulação direta do DOM via ref) e manda um `resize` para o servidor. O cleanup faz `observer.disconnect()`.

#### Effect 4 — Paste fallback (`deps: [send]`)

`document.addEventListener('paste', ...)` no global. Cleanup remove o listener. Resolve o caso de o usuário colar texto fora do canvas (no input de URL, por exemplo) — converte cada caractere em `keydown` e envia.

> `useEffect`: <https://react.dev/reference/react/useEffect>

### 9.4.5 `useCallback` — por que `send` é memoizado

```tsx
const send = useCallback((obj) => { ... }, []);
```

Sem `useCallback`, toda renderização de `<App />` criaria uma `send` nova → seria passada como prop diferente para `<Canvas />` → o `useEffect` interno do Canvas re-executaria, removendo e re-anexando todos os listeners de mouse/teclado. **Catastrófico para performance.**

Com `useCallback(..., [])`, `send` é a mesma função entre renders. Mas tem um detalhe: o `Canvas` ainda usa `useRef + useEffect` pra "sincronizar" a versão atual dela:

```tsx
const sendRef = useRef(send);
useEffect(() => { sendRef.current = send; });
```

Esse padrão (`latest ref`) é o jeito canônico de chamar callbacks "frescos" de dentro de listeners DOM que foram anexados uma vez só. Veja o motivo: se o listener capturasse `send` por closure, ele sempre chamaria a versão *original*. Usando `sendRef.current()`, sempre chama a mais recente.

> `useCallback`: <https://react.dev/reference/react/useCallback>
> Padrão "latest ref": <https://www.epicreact.dev/the-latest-ref-pattern-in-react>

### 9.4.6 Refs DOM — `canvasRef` e `viewportRef`

```tsx
const canvasRef = useRef<HTMLCanvasElement>(null);
...
<canvas ref={canvasRef} id="screen" />
```

O React preenche `canvasRef.current` com o nó DOM real **depois** do commit. Antes do primeiro render, é `null` — por isso todos os usos checam `if (canvas)`.

A prop `canvasRef` é passada *de baixo pra cima*: criada em `App`, repassada para `<Canvas />`, que faz `<canvas ref={canvasRef} />`. Isso permite que o pai (`App`) chame `canvasRef.current?.focus()` quando o usuário clica num botão da barra. (Alternativa moderna seria `forwardRef`, mas passar como prop é igualmente válido em React 19.)

> Refs em DOM: <https://react.dev/reference/react/useRef#manipulating-the-dom-with-a-ref>

### 9.4.7 O `<canvas>` é "fora da árvore React"

Ponto importante: depois que o `<canvas>` é montado, **o React não tem mais nada a ver com o que aparece nele**. O conteúdo dos pixels é desenhado por `drawJpegFrame`, que faz `ctx.drawImage(...)` direto. O React não re-renderiza nada quando um frame chega.

Isso é proposital: re-renderizar via React a 25 fps seria desperdício total. O React só toca o DOM quando o **estado da UI** muda (URL nova, ping, banner de download).

### 9.4.8 Atualizações controladas pelo servidor

Quando uma mensagem WebSocket chega:

```tsx
ws.onmessage = async (ev) => {
  if (typeof ev.data !== 'string') {
    await drawJpegFrame(canvas, ev.data, vpW.current, vpH.current); // não passa por React
    return;
  }
  const msg = JSON.parse(ev.data);
  if (msg.t === 'url') setUrlValue(msg.url);              // dispara re-render
  else if (msg.t === 'pong') setPingText('... ms');       // dispara re-render
  else if (msg.t === 'download_ready') onDownloadReady(...); // dispara re-render
};
```

Cada `setX(...)` agenda um re-render do `<App />`. O React 19 batcha múltiplos `setState` no mesmo handler em um único render (automatic batching).

> Automatic batching no React 18+: <https://react.dev/blog/2022/03/29/react-v18#new-feature-automatic-batching>

### 9.4.9 Vite + JSX + TypeScript — o que acontece no build

`vite.config.ts`:
```ts
plugins: [react()],
build: { outDir: '../public' },
```

- `@vitejs/plugin-react` integra o **SWC** (ou Babel) para transformar JSX → `React.createElement(...)`.
- TypeScript é compilado *separadamente* (`tsc -b` no script `build`) só para checagem; o Vite usa esbuild para a transpilação rápida.
- Saída: `index.html` + `assets/index-[hash].js` + `assets/index-[hash].css`, todos copiados para `public/`, que o servidor Bun então serve estaticamente.

Em desenvolvimento (`bun run dev`), o Vite roda um dev server com **HMR** (Hot Module Replacement) e o `react-refresh` plugin preserva estado de componentes durante edits.

> Vite + React: <https://vite.dev/guide/features#jsx>
> React Refresh: <https://github.com/facebook/react/tree/main/packages/react-refresh>

### 9.4.10 Resumo: divisão de responsabilidades

| Coisa | Quem cuida |
|-------|-----------|
| Layout (barra, viewport, overlay) | React (`App.tsx`) |
| Estado da UI (URL, ping, banner) | `useState` em `App` |
| Conexão WebSocket | `useRef` + `useEffect` em `App` |
| Listeners de input (mouse/teclado) | `useEffect` em `Canvas` (DOM puro) |
| Renderização do conteúdo do navegador | `drawImage` em `<canvas>` (zero React) |
| Detecção de resize | `ResizeObserver` em `useEffect` |
| Lógica pura (mapeamentos, conversões) | `utils/index.ts` (sem React) |

**Princípio geral**: React para o que muda raramente e precisa de re-render. DOM puro para o que muda 25 vezes por segundo.

---

## 10. Como cada usuário tem sua própria aba

Resumindo o ponto crítico: **cada WebSocket → uma `page` nova**.

```
   Cliente A conecta  →  ws#A  →  createSession(browser, ws#A)  →  pageA + cdpA
   Cliente B conecta  →  ws#B  →  createSession(browser, ws#B)  →  pageB + cdpB
```

- O `Browser` é único e compartilhado (uma instância de Chromium).
- Cada `page` tem seu próprio screencast CDP, suas próprias coordenadas de mouse, sua própria URL e seu próprio diretório de download.
- As 4 flags `--disable-*-throttling` + `Emulation.setFocusEmulationEnabled` + `Page.setWebLifecycleState: 'active'` impedem que o Chromium "pause" abas que não estão em foco — sem elas, só o último usuário a conectar veria atualizações.
- Quando o WebSocket fecha (`ws.on('close')`), o `stop()` cancela o screencast, limpa downloads, e `page.close()` fecha a aba.

Para usar contextos completamente isolados (cookies separados etc.), bastaria trocar `browser.newPage()` por `browser.createBrowserContext().then(ctx => ctx.newPage())` — útil se virar um produto multi-tenant.

---

## 11. Comunicação WebSocket — protocolo completo

O caminho é `/ws` em ambos `http` e `https`. Há duas categorias de frames:

### Binárias (servidor → cliente)
Bytes brutos JPEG. O cliente os recebe como `ArrayBuffer` e desenha com `drawJpegFrame`.

### Texto (JSON, ambos os sentidos)
Discriminadas pelo campo `t`:

#### Cliente → servidor

| `t`       | Payload                                             | Efeito |
|-----------|-----------------------------------------------------|--------|
| `nav`     | `{ url }`                                           | `page.goto(url)` |
| `back`    | —                                                   | `page.goBack()` |
| `fwd`     | —                                                   | `page.goForward()` |
| `reload`  | —                                                   | `page.reload()` |
| `resize`  | `{ w, h }`                                          | `page.setViewport(...)` (debounced 150 ms) |
| `mouse`   | `{ d: <CDP Input.dispatchMouseEvent params> }`      | encaminha cru ao CDP |
| `wheel`   | `{ x, y, dx, dy, mod }`                             | vira `mouseWheel` no CDP |
| `keydown` | `{ d: <CDP Input.dispatchKeyEvent params> }`        | `keyDown` + opcional `char` |
| `keyup`   | `{ d: <CDP Input.dispatchKeyEvent params> }`        | `keyUp` |
| `ping`    | —                                                   | dispara `pong` |

#### Servidor → cliente

| `t`               | Payload                              | Origem |
|-------------------|--------------------------------------|--------|
| `url`             | `{ url }`                            | `page.on('framenavigated')` |
| `title`           | `{ title }`                          | `page.on('domcontentloaded')` |
| `pong`            | —                                    | resposta de `ping` |
| `download_start`  | `{ guid, filename }`                 | `cdp.on('Page.downloadWillBegin')` |
| `download_ready`  | `{ guid, filename, data: base64 }`   | `cdp.on('Page.downloadProgress' ...completed)` |

`perMessageDeflate: false` está intencional: ativá-lo gastaria CPU comprimindo JPEG que já está comprimido, sem ganho.

> Spec WebSocket (RFC 6455): <https://datatracker.ietf.org/doc/html/rfc6455>
> `ws` API: <https://github.com/websockets/ws/blob/master/doc/ws.md>

---

## 12. Como as "rotas" se comunicam

Não há roteamento HTTP convencional (não é REST). O único endpoint relevante é:

| Path        | Servidor       | Função |
|-------------|----------------|--------|
| `GET /`     | `serveStatic`  | Devolve `public/index.html` (entry React). |
| `GET /*`    | `serveStatic`  | Tenta servir o arquivo; se 404, cai no SPA fallback (`index.html`). |
| `WS /ws`    | `ws.WebSocketServer` | Upgrade para WebSocket; toda a interação acontece aqui. |

O upgrade WebSocket funciona porque o `WebSocketServer` é construído com `{ server, path: '/ws' }`. O `ws` então registra um listener para o evento `upgrade` do `http.Server` e captura **apenas** os requests cuja URL bate com `/ws`. Tudo o que não é upgrade segue para o `serveStatic`.

Em produção, o Traefik (`compose.yml`) faz mais um nível de roteamento:

- Rule `Host(${RELAY_HOST})` → roteia para o serviço `relay`.
- TLS via Let's Encrypt (`certresolver=letsencrypt`).
- Middleware `relay-auth` aplica Basic Auth (bcrypt) — usuário `admin`, senha embarcada.
- Backend HTTP na porta 3050 (HTTPS termina na borda, e o WebSocket passa transparente porque o Traefik suporta upgrade automaticamente).

> Traefik WebSocket: <https://doc.traefik.io/traefik/middlewares/http/headers/#websocket-headers> (qualquer roteador HTTP do Traefik já encaminha o `Upgrade` corretamente; nada extra a configurar).

---

## 13. Variáveis de ambiente

| Variável | Default | Onde é lida |
|----------|---------|-------------|
| `HTTP_PORT` | `3050` | `index.ts` |
| `HTTPS_PORT` | `3051` | `index.ts` |
| `SSL_KEY` / `SSL_CERT` | `key.pem` / `cert.pem` | `index.ts` |
| `CHROMIUM_PATH` | `/usr/bin/chromium-browser` | `browser.ts` |
| `FRAME_W` / `FRAME_H` | `1280` / `720` | `session.ts` |
| `FRAME_QUALITY` | `70` | `session.ts` (passado a `Page.startScreencast`) |
| `DEFAULT_URL` | `google.com` | `session.ts` |
| `RELAY_HOST` | — | `compose.yml` (label do Traefik) |

---

## 14. Build & deploy

### Desenvolvimento

```bash
# Cliente (hot reload)
cd app && bun install && bun run dev

# Servidor
bun install
bun src/index.ts
```

### Build do cliente

```bash
cd app && bun run build       # gera artefatos em ../public/
```

### Container

`Dockerfile` usa multi-stage:

1. **`web`** (`oven/bun:1.3-alpine`): instala deps do `app/`, roda `bun run build` → joga em `/repo/public`.
2. **`runtime`** (`oven/bun:1.3-alpine`): instala Chromium nativo do Alpine, gera self-signed cert, instala deps de produção do servidor, copia `src/` e o `public/` da etapa anterior. `tini` é PID 1 para reapear processos zumbis do Chromium.

`PUPPETEER_SKIP_DOWNLOAD=true` evita que o Puppeteer baixe seu próprio Chromium (já temos o do sistema).

---

## 15. Referências oficiais consultadas

- **Chrome DevTools Protocol** — <https://chromedevtools.github.io/devtools-protocol/>
  - `Page.startScreencast` / `Page.screencastFrame` / `Page.screencastFrameAck`
  - `Page.setDownloadBehavior` / `Page.downloadWillBegin` / `Page.downloadProgress`
  - `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`
  - `Emulation.setFocusEmulationEnabled` / `Page.setWebLifecycleState`
- **Puppeteer** — <https://pptr.dev/>
  - `puppeteer.launch` — <https://pptr.dev/api/puppeteer.puppeteernode.launch>
  - `Page.createCDPSession` — <https://pptr.dev/api/puppeteer.page.createcdpsession>
  - `Page.goto` / `setViewport` / `goBack` / `goForward` / `reload`
- **`ws`** (WebSocket Node) — <https://github.com/websockets/ws#readme>
- **MDN Web APIs**
  - `WebSocket` — <https://developer.mozilla.org/en-US/docs/Web/API/WebSocket>
  - `createImageBitmap` — <https://developer.mozilla.org/en-US/docs/Web/API/createImageBitmap>
  - `ResizeObserver` — <https://developer.mozilla.org/en-US/docs/Web/API/ResizeObserver>
  - `Canvas 2D drawImage` — <https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/drawImage>
- **React 19** — <https://react.dev/reference/react>
- **Vite** — <https://vite.dev/config/>
- **Bun** — <https://bun.com/docs>
- **Traefik (Docker provider, basicauth)** — <https://doc.traefik.io/traefik/routing/providers/docker/> e <https://doc.traefik.io/traefik/middlewares/http/basicauth/>
- **Chromium switches** — <https://peter.sh/experiments/chromium-command-line-switches/>
- **RFC 6455 (WebSocket)** — <https://datatracker.ietf.org/doc/html/rfc6455>

---

## 16. Resumo do fluxo de uma interação típica

Usuário move o mouse:

1. `<canvas>` recebe `mousemove`.
2. `scaleCoords` mapeia para coords da viewport do Chromium.
3. `send({ t: 'mouse', d: { type: 'mouseMoved', x, y, modifiers } })`.
4. `WebSocket` envia o JSON.
5. `handler.ts` faz `JSON.parse`, cai em `case 'mouse'`, chama `cdp.send('Input.dispatchMouseEvent', msg.d)`.
6. Chromium dispara o evento DOM `mousemove` na página real.
7. A página renderiza algo novo.
8. CDP emite `Page.screencastFrame` com o JPEG resultante.
9. Listener do `session.ts` envia o `Buffer` binário pelo WebSocket.
10. Cliente recebe `ArrayBuffer`, `createImageBitmap` decodifica, `drawImage` pinta no `<canvas>`.

Tempo total: tipicamente 30–80 ms em rede local (visível no contador de ping da UI).
