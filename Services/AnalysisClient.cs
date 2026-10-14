using Microsoft.JSInterop;
using System.Text.Json;

namespace NeuralMetricWeb_v1.Services;

public sealed class AnalysisClient : IAsyncDisposable
{
    private readonly IJSRuntime _js;
    private IJSObjectReference? _module;

    public AnalysisClient(IJSRuntime js) => _js = js;

    // Pass both values for a manual window (minutes from the session start),
    // or leave both null for automatic maintenance detection.
    public async Task<JsonElement> AnalyzeAsync(string inputId, double? startMin, double? endMin,
                                                DotNetObjectReference<ProgressReporter>? progress = null,
                                                string? channel = null)
    {
        _module ??= await _js.InvokeAsync<IJSObjectReference>("import", "./js/analysis.js");
        double[]? window = startMin is null || endMin is null
            ? null
            : new[] { startMin.Value, endMin.Value };
        return await _module.InvokeAsync<JsonElement>("analyzeSelection", inputId, window, progress, channel);
    }

    // Available analysis channels for the picker (EDF labels or BIS channels).
    public async Task<JsonElement> ChannelsInfoAsync(string inputId)
    {
        _module ??= await _js.InvokeAsync<IJSObjectReference>("import", "./js/analysis.js");
        return await _module.InvokeAsync<JsonElement>("channelsInfo", inputId);
    }

    // Re-run the report on the already-loaded session with a manual window.
    public async Task<JsonElement> ReanalyzeWindowAsync(double startMin, double endMin,
                                                        DotNetObjectReference<ProgressReporter>? progress = null)
    {
        _module ??= await _js.InvokeAsync<IJSObjectReference>("import", "./js/analysis.js");
        return await _module.InvokeAsync<JsonElement>("reanalyzeWindow", new[] { startMin, endMin }, progress);
    }

    public sealed record SessionInfo(int Count, int Minutes, int? Est, string? StartIso, string? EndIso);

    public async Task<SessionInfo> SessionInfoAsync(string inputId)
    {
        _module ??= await _js.InvokeAsync<IJSObjectReference>("import", "./js/analysis.js");
        var el = await _module.InvokeAsync<JsonElement>("sessionInfo", inputId);
        int count = el.GetProperty("count").GetInt32();
        int minutes = el.GetProperty("minutes").GetInt32();
        int? est = el.TryGetProperty("estSeconds", out var e) && e.ValueKind == JsonValueKind.Number
            ? e.GetInt32() : null;
        string? startIso = el.TryGetProperty("startIso", out var sv) && sv.ValueKind == JsonValueKind.String ? sv.GetString() : null;
        string? endIso = el.TryGetProperty("endIso", out var ev) && ev.ValueKind == JsonValueKind.String ? ev.GetString() : null;
        return new SessionInfo(count, minutes, est, startIso, endIso);
    }

    public async Task RecordRunAsync(int minutes, double seconds)
    {
        _module ??= await _js.InvokeAsync<IJSObjectReference>("import", "./js/analysis.js");
        try { await _module.InvokeVoidAsync("recordRun", minutes, seconds); } catch { }
    }

    public async Task<int> FileCountAsync(string inputId)
    {
        _module ??= await _js.InvokeAsync<IJSObjectReference>("import", "./js/analysis.js");
        return await _module.InvokeAsync<int>("edfCount", inputId);
    }

    public async Task WarmupAsync()
    {
        _module ??= await _js.InvokeAsync<IJSObjectReference>("import", "./js/analysis.js");
        try { await _module.InvokeVoidAsync("warmup"); } catch { }
    }

    public async Task<JsonElement> AnalyzeReviewAsync(string inputId,
                                                      DotNetObjectReference<ProgressReporter>? progress = null,
                                                      string? channel = null)
    {
        _module ??= await _js.InvokeAsync<IJSObjectReference>("import", "./js/analysis.js");
        return await _module.InvokeAsync<JsonElement>("analyzeReview", inputId, progress, channel);
    }

    public async ValueTask DisposeAsync()
    {
        if (_module is not null) await _module.DisposeAsync();
    }
}
