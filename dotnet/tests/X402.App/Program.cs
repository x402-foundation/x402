using System.Text.Json.Nodes;
using X402.AspNetCore;
using X402.Core.Roles;
using X402.Mechanisms.Evm;
using X402.Mechanisms.Evm.Exact;
using X402.Core.Protocol.V2;

var builder = WebApplication.CreateBuilder(args);

// Add services to the container.
// Learn more about configuring OpenAPI at https://aka.ms/aspnet/openapi
builder.Services.AddOpenApi();
builder.Services.AddX402(options =>
{
    options
        .UseHttpFacilitator("https://x402.org/facilitator")
        .RegisterFacilitatedScheme(EvmSchemes.Exact);
});

var app = builder.Build();

var requirements = new PaymentRequirements(
    Scheme: EvmSchemes.Exact,
    Network: EvmChains.BaseSepolia,
    Asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    Amount: "10000",
    PayTo: "0x1111111111111111111111111111111111111111",
    MaxTimeoutSeconds: 300,
    Extra: new JsonObject
    {
        ["name"] = "USD Coin",
        ["version"] = "2"
    });

// Configure the HTTP request pipeline.
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

app.UseHttpsRedirection();

var summaries = new[]
{
    "Freezing", "Bracing", "Chilly", "Cool", "Mild", "Warm", "Balmy", "Hot", "Sweltering", "Scorching"
};

app.MapGet("/weatherforecast", () =>
    {
        var forecast = Enumerable.Range(1, 5).Select(index =>
                new WeatherForecast
                (
                    DateOnly.FromDateTime(DateTime.Now.AddDays(index)),
                    Random.Shared.Next(-20, 55),
                    summaries[Random.Shared.Next(summaries.Length)]
                ))
            .ToArray();
        return forecast;
    })
    .WithName("GetWeatherForecast")
    .RequireX402Payment(requirements);

app.Run();

record WeatherForecast(DateOnly Date, int TemperatureC, string? Summary)
{
    public int TemperatureF => 32 + (int)(TemperatureC / 0.5556);
}