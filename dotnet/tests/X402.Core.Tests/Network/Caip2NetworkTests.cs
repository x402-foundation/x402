using X402.Core.Network;

namespace X402.Core.Tests.Network;

public sealed class Caip2NetworkTests
{
    [Fact]
    public void TryParse_ReturnsTrue_ForValidNetwork()
    {
        var parsed = Caip2Network.TryParse("eip155:84532", out var network);

        Assert.True(parsed);
        Assert.Equal("eip155", network.Namespace);
        Assert.Equal("84532", network.Reference);
    }

    [Theory]
    [InlineData("")]
    [InlineData("eip155")]
    [InlineData("eip155:")]
    [InlineData(":84532")]
    [InlineData("eip155:84532:extra")]
    public void TryParse_ReturnsFalse_ForInvalidNetwork(string value)
    {
        Assert.False(Caip2Network.TryParse(value, out _));
    }

    [Fact]
    public void Matches_ReturnsTrue_ForWildcardPattern()
    {
        var network = new Caip2Network("eip155:1");
        var wildcard = new Caip2Network("eip155:*");

        Assert.True(network.Matches(wildcard));
        Assert.True(wildcard.Matches(network));
    }

    [Fact]
    public void Matches_ReturnsFalse_ForDifferentNamespaces()
    {
        var evm = new Caip2Network("eip155:1");
        var solana = new Caip2Network("solana:mainnet-beta");

        Assert.False(evm.Matches(solana));
    }
}