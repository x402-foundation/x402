using System.Text.Json.Nodes;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using X402.AspNetCore;
using X402.Core.Protocol.V2;
using X402.Core.Roles;
using X402.Mechanisms.Evm;
using X402.Mechanisms.Evm.Exact;

static string GetEnv(string key, string fallback)
{
  var value = Environment.GetEnvironmentVariable(key);
  return string.IsNullOrWhiteSpace(value) ? fallback : value;
}

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddX402();

var app = builder.Build();

var evmNetwork = GetEnv("EVM_NETWORK", EvmChains.BaseSepolia);
var evmAsset = GetEnv("EVM_ASSET", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
var evmAmount = GetEnv("EVM_AMOUNT", "10000");
var evmPayee = GetEnv("EVM_PAYEE_ADDRESS", "0x4444444444444444444444444444444444444444");
var evmTokenName = GetEnv("EVM_TOKEN_NAME", "USD Coin");
var evmTokenVersion = GetEnv("EVM_TOKEN_VERSION", "2");
var facilitatorUrl = GetEnv("FACILITATOR_URL", "http://localhost:4021");

var premiumRequirements = new PaymentRequirements(
    Scheme: EvmSchemes.Exact,
    Network: evmNetwork,
    Asset: evmAsset,
    Amount: evmAmount,
    PayTo: evmPayee,
    MaxTimeoutSeconds: 300,
    Extra: new JsonObject
    {
      ["name"] = evmTokenName,
      ["version"] = evmTokenVersion
    });

var server = app.Services.GetRequiredService<IX402ResourceServer>();
server.RegisterSchemeVerifier(EvmSchemes.Exact, EvmExactVerifier.Create());

app.UseX402Payment(options =>
{
  options.DefaultFacilitatorUrl = facilitatorUrl;
  options.Protect("/api/premium", premiumRequirements);
});

app.MapGet("/", () => Results.Ok(new
{
  example = "middleware-example",
  protectedRoutes = new[] { "/api/premium" },
  unprotectedRoute = "/unprotected"
}));

app.MapGet("/health", () => Results.Ok(new { status = "ok" }));

app.MapPost("/close", (IHostApplicationLifetime lifetime) =>
{
  _ = Task.Run(lifetime.StopApplication);
  return Results.Ok(new { message = "Shutting down" });
});

app.MapGet("/unprotected", () => Results.Ok(new
{
  route = "/unprotected",
  paymentRequired = false
}));

app.MapGet("/api/premium", () => Results.Ok(new
{
  route = "/api/premium",
  tier = "premium",
  protection = "middleware"
}));

app.Run();