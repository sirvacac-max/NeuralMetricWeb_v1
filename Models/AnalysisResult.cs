using System.Text.Json.Serialization;

namespace NeuralMetricWeb_v1.Models;

public sealed class AnalysisResult
{
    [JsonPropertyName("delta_pct")] public double DeltaPct { get; set; }
    [JsonPropertyName("theta_pct")] public double ThetaPct { get; set; }
    [JsonPropertyName("alpha_pct")] public double AlphaPct { get; set; }
    [JsonPropertyName("beta_pct")] public double BetaPct { get; set; }
    [JsonPropertyName("delta_uv2")] public double DeltaUv2 { get; set; }
    [JsonPropertyName("theta_uv2")] public double ThetaUv2 { get; set; }
    [JsonPropertyName("alpha_uv2")] public double AlphaUv2 { get; set; }
    [JsonPropertyName("beta_uv2")] public double BetaUv2 { get; set; }
    [JsonPropertyName("total_uv2")] public double TotalUv2 { get; set; }
    [JsonPropertyName("sef95_hz")] public double Sef95Hz { get; set; }
    [JsonPropertyName("valid_pct")] public double ValidPct { get; set; }
    [JsonPropertyName("n_valid")] public int NValid { get; set; }
    [JsonPropertyName("n_windows")] public int NWindows { get; set; }
    [JsonPropertyName("clipped_pct_window")] public double ClippedPctWindow { get; set; }
    [JsonPropertyName("analysed_min")] public double AnalysedMin { get; set; }
    [JsonPropertyName("window_min")] public double[]? WindowMin { get; set; }
}