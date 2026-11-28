using X402.Core.Protocol.Versioning;

namespace X402.Core.Tests.Protocol.Versioning;

public sealed class ProtocolVersionDetectorTests
{
    [Fact]
    public void DetectVersion_ReturnsV1_WhenPayloadContainsV1Version()
    {
        const string json = """
        {
          "x402Version": 1,
          "scheme": "exact",
          "network": "base-sepolia",
          "payload": {}
        }
        """;

        var detected = ProtocolVersionDetector.DetectVersion(json);

        Assert.Equal(1, detected);
    }

    [Fact]
    public void DetectVersion_ReturnsV2_WhenPayloadContainsV2Version()
    {
        const string json = """
        {
          "x402Version": 2,
          "accepted": {
            "scheme": "exact",
            "network": "eip155:84532",
            "asset": "0xasset",
            "amount": "10000",
            "payTo": "0xmerchant",
            "maxTimeoutSeconds": 60
          },
          "payload": {}
        }
        """;

        var detected = ProtocolVersionDetector.DetectVersion(json);

        Assert.Equal(2, detected);
    }

    [Fact]
    public void DeserializePaymentPayload_ReturnsTypedV1Payload_WhenVersionIs1()
    {
        const string json = """
        {
          "x402Version": 1,
          "scheme": "exact",
          "network": "base-sepolia",
          "payload": {}
        }
        """;

        var payload = ProtocolVersionDetector.DeserializePaymentPayload(json);

        Assert.IsType<X402.Core.Protocol.V1.PaymentPayload>(payload);
    }

    [Fact]
    public void DeserializePaymentPayload_ReturnsTypedV2Payload_WhenVersionIs2()
    {
        const string json = """
        {
          "x402Version": 2,
          "accepted": {
            "scheme": "exact",
            "network": "eip155:84532",
            "asset": "0xasset",
            "amount": "10000",
            "payTo": "0xmerchant",
            "maxTimeoutSeconds": 60
          },
          "payload": {}
        }
        """;

        var payload = ProtocolVersionDetector.DeserializePaymentPayload(json);

        Assert.IsType<X402.Core.Protocol.V2.PaymentPayload>(payload);
    }
}