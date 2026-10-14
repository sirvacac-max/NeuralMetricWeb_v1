using Microsoft.JSInterop;

namespace NeuralMetricWeb_v1.Services;

// Lets analysis.js report a stage ("reading" / "processing" / "done") back to the page.
public sealed class ProgressReporter
{
    private readonly Action<string> _onStage;
    public ProgressReporter(Action<string> onStage) => _onStage = onStage;

    [JSInvokable]
    public void Stage(string stage) => _onStage(stage);
}
