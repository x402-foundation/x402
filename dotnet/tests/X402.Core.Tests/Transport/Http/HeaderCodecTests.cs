using System.Text.Json.Nodes;
using X402.Core.Protocol.V2;
using X402.Core.Transport.Http;

namespace X402.Core.Tests.Transport.Http;

public sealed class HeaderCodecTests
{
    [Fact]
    public void EncodeDecode_RoundTripsV2PaymentRequired()
    {
        var message = new PaymentRequired(
            X402Version: 2,
            Accepts:
            [
                new PaymentRequirements(
                    Scheme: "exact",
                    Network: "eip155:84532",
                    Asset: "0xasset",
                    Amount: "10000",
                    PayTo: "0xmerchant",
                    MaxTimeoutSeconds: 60,
                    Extra: new JsonObject { ["name"] = "USDC" })
            ],
            Error: "PAYMENT-SIGNATURE header is required",
            Resource: new ResourceInfo("https://api.example.com/weather", "Weather data", "application/json"));

        var encoded = HeaderCodec.Encode(message);
        var decoded = HeaderCodec.Decode<PaymentRequired>(encoded);

        Assert.Equal(2, decoded.X402Version);
        Assert.Single(decoded.Accepts);
        Assert.Equal("exact", decoded.Accepts[0].Scheme);
        Assert.Equal("eip155:84532", decoded.Accepts[0].Network);
    }

    [Fact]
    public void Decode_Throws_WhenHeaderIsNotBase64()
    {
        Assert.Throws<InvalidDataException>(() => HeaderCodec.Decode<PaymentRequired>("!!!not-base64!!!"));
    }
}