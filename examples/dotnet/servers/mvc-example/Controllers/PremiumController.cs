using Microsoft.AspNetCore.Mvc;
using X402.AspNetCore;
using X402.Mechanisms.Evm;

namespace MvcExample.Controllers;

[ApiController]
[Route("premium")]
[RequireX402Payment(
    scheme: EvmSchemes.Exact,
    network: EvmChains.BaseSepolia,
    asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    amount: "10000",
    payTo: "0x2222222222222222222222222222222222222222",
    tokenName: "USD Coin",
    tokenVersion: "2")]
public sealed class PremiumController : ControllerBase
{
  [HttpGet("data")]
  public IActionResult GetData()
  {
    var payer = HttpContext.Items.TryGetValue(X402HttpContextKeys.Payer, out var value)
        ? value?.ToString()
        : null;

    return Ok(new
    {
      route = "/premium/data",
      report = "daily",
      paidBy = payer,
      protection = "mvc-attribute"
    });
  }

  [HttpGet("analytics")]
  public IActionResult GetAnalytics()
  {
    var payer = HttpContext.Items.TryGetValue(X402HttpContextKeys.Payer, out var value)
        ? value?.ToString()
        : null;

    return Ok(new
    {
      route = "/premium/analytics",
      visits = 128,
      conversionRate = 0.14,
      paidBy = payer,
      protection = "mvc-attribute"
    });
  }
}