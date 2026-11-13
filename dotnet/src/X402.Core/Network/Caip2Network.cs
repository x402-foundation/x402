namespace X402.Core.Network;

public readonly record struct Caip2Network
{
    public string Value { get; }

    public Caip2Network(string value)
    {
        if (!TryParse(value, out var parsed))
        {
            throw new ArgumentException($"Invalid CAIP-2 network: {value}", nameof(value));
        }

        Value = parsed.Value;
    }

    public string Namespace
    {
        get
        {
            var separator = Value.IndexOf(':');
            return separator > 0 ? Value[..separator] : string.Empty;
        }
    }

    public string Reference
    {
        get
        {
            var separator = Value.IndexOf(':');
            return separator > -1 && separator + 1 < Value.Length ? Value[(separator + 1)..] : string.Empty;
        }
    }

    public bool IsWildcard => Reference == "*";

    public bool Matches(Caip2Network other)
    {
        if (Value == other.Value)
        {
            return true;
        }

        if (IsWildcard && Namespace == other.Namespace)
        {
            return true;
        }

        return other.IsWildcard && Namespace == other.Namespace;
    }

    public static bool TryParse(string input, out Caip2Network network)
    {
        network = default;

        if (string.IsNullOrWhiteSpace(input))
        {
            return false;
        }

        var parts = input.Split(':', StringSplitOptions.None);
        if (parts.Length != 2)
        {
            return false;
        }

        var ns = parts[0].Trim();
        var reference = parts[1].Trim();
        if (ns.Length == 0 || reference.Length == 0)
        {
            return false;
        }

        if (ns.Contains(' ') || reference.Contains(' '))
        {
            return false;
        }

        network = new Caip2Network($"{ns}:{reference}", true);
        return true;
    }

    private Caip2Network(string value, bool _)
    {
        Value = value;
    }

    public override string ToString() => Value;
}