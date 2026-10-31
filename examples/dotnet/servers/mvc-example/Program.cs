using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using X402.AspNetCore;
using X402.Core.Roles;
using X402.Mechanisms.Evm;
using X402.Mechanisms.Evm.Exact;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers();
builder.Services.AddX402();

var app = builder.Build();

var server = app.Services.GetRequiredService<IX402ResourceServer>();
server.RegisterSchemeVerifier(EvmSchemes.Exact, EvmExactVerifier.Create());

app.MapGet("/", () => Results.Ok(new
{
  example = "mvc-example",
  protectedRoute = "/premium/data"
}));

app.MapGet("/health", () => Results.Ok(new { status = "ok" }));

app.MapPost("/close", (IHostApplicationLifetime lifetime) =>
{
  _ = Task.Run(lifetime.StopApplication);
  return Results.Ok(new { message = "Shutting down" });
});

app.MapControllers();

app.Run();