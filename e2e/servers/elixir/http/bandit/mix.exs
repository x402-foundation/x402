defmodule X402.E2EServer.MixProject do
  use Mix.Project

  def project do
    [
      app: :x402_e2e_server,
      version: "0.1.0",
      elixir: "~> 1.19",
      start_permanent: false,
      deps: deps()
    ]
  end

  def application do
    [
      extra_applications: [:logger],
      mod: {E2eServer.Application, []}
    ]
  end

  defp deps do
    [
      # The Elixir x402 SDK (https://hex.pm/packages/x402)
      {:x402, "~> 0.9.6"},
      {:bandit, "~> 1.0"},
      {:finch, "~> 0.19"},
      {:jason, "~> 1.2"}
    ]
  end
end
