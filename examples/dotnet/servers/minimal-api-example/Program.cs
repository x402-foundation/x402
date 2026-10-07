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
var evmPayee = GetEnv("EVM_PAYEE_ADDRESS", "0x1111111111111111111111111111111111111111");
var evmTokenName = GetEnv("EVM_TOKEN_NAME", "USD Coin");
var evmTokenVersion = GetEnv("EVM_TOKEN_VERSION", "2");

var weatherRequirements = new PaymentRequirements(
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

app.MapGet("/", () => Results.Ok(new
{
  example = "minimal-api-example",
  protectedRoute = "/weather"
}));

app.MapGet("/health", () => Results.Ok(new { status = "ok" }));

app.MapPost("/close", (IHostApplicationLifetime lifetime) =>
{
  _ = Task.Run(lifetime.StopApplication);
  return Results.Ok(new { message = "Shutting down" });
});

app.MapGet("/weather", (HttpContext context) =>
{
  var payer = context.Items.TryGetValue(X402HttpContextKeys.Payer, out var value)
      ? value?.ToString()
      : null;

  return Results.Ok(new
  {
    city = "Lagos",
    forecast = "clear",
    temperatureC = 29,
    paidBy = payer,
    protection = "minimal-api"
  });
})
.RequireX402Payment(weatherRequirements);

app.Run();