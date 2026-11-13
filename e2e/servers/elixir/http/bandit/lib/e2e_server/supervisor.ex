defmodule E2eServer.Supervisor do
  @moduledoc """
  Supervision tree for the e2e resource server.

  Children: a `Finch` pool, the `X402.Facilitator` client, the payment
  idempotency cache, and a `Bandit` listener serving `E2eServer.Router`.

  `X402.Plug.PaymentGate` options are compiled once from the resolved catalog
  routes and stored in `:persistent_term` before the listener starts, so the
  first request is already gated.
  """

  use Supervisor

  alias E2eServer.Config
  alias X402.Extensions.PaymentIdentifier.ETSCache

  @finch_name E2eServer.Finch
  @facilitator_name E2eServer.Facilitator
  @cache_name E2eServer.PaymentCache

  @spec start_link(Config.t()) :: Supervisor.on_start()
  def start_link(%Config{} = config) do
    Supervisor.start_link(__MODULE__, config, name: __MODULE__)
  end

  @impl Supervisor
  def init(%Config{} = config) do
    put_terms(config)

    children = [
      {Finch, name: @finch_name},
      {X402.Facilitator,
       name: @facilitator_name, url: config.facilitator_url, finch: @finch_name},
      {ETSCache, name: @cache_name},
      {Bandit, plug: E2eServer.Router, port: config.port, ip: {0, 0, 0, 0}}
    ]

    Supervisor.init(children, strategy: :one_for_one)
  end

  @doc """
  Prints the startup banner, ending with the `Server listening` readiness
  line the harness waits for on stdout.
  """
  @spec print_banner(Config.t()) :: :ok
  def print_banner(%Config{} = config) do
    IO.puts("Starting Bandit server on port #{config.port}")

    config.routes
    |> Enum.map(& &1.network_id)
    |> Enum.uniq()
    |> Enum.each(fn network_id ->
      route = Enum.find(config.routes, &(&1.network_id == network_id))
      IO.puts("  #{network_id}: #{route.network} -> #{route.pay_to}")
    end)

    IO.puts("Using facilitator: #{config.facilitator_url}")

    Enum.each(config.routes, fn route ->
      IO.puts("  GET  #{route.path}  (#{route.network_id} #{route.scheme})")
    end)

    IO.puts("  GET  /health  (no payment required)")
    IO.puts("  POST /close  (shutdown server)")
    IO.puts("Server listening on port #{config.port}")
  end

  defp put_terms(%Config{} = config) do
    gate_options =
      X402.Plug.PaymentGate.init(
        facilitator: @facilitator_name,
        payment_identifier_cache: @cache_name,
        routes: Enum.map(config.routes, &gate_route/1)
      )

    :persistent_term.put({E2eServer, :gate}, gate_options)

    :persistent_term.put({E2eServer, :state}, %{
      routes: config.routes,
      paid_paths: MapSet.new(config.routes, & &1.path),
      unconfigured: config.unconfigured,
      stopper: config.stopper
    })

    :ok
  end

  defp gate_route(route) do
    %{
      method: :get,
      path: route.path,
      description: route.description,
      accepts: [
        %{
          scheme: route.scheme,
          price: route.amount,
          network: route.network,
          asset: route.asset,
          pay_to: route.pay_to,
          extra: route.extra
        }
      ]
    }
  end
end
