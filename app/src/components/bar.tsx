
const Bar = ({ pingValue }: { pingValue: string }) => {
    return (
        <div id="bar">
            <span id="ping">{pingValue}</span>
        </div>
    );
};

export default Bar;