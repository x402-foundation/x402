defmodule E2eServer.Config do
  @moduledoc """
  Boot-time configuration for the e2e resource server.

  Everything is resolved once from the process environment (or an injected
  env lookup, in tests) and stored in `:persistent_term` by the supervisor:
  the request path never re-reads the catalog.
  """

  alias E2eServer.Catalog

  @default_port 4021

  @type t :: %__MODULE__{
          port: non_neg_integer(),
          facilitator_url: String.t(),
          routes: [Catalog.resolved_route()],
          unconfigured: %{optional(String.t()) => map()},
          stopper: (-> any())
        }

  defstruct [:port, :facilitator_url, :routes, :unconfigured, :stopper]

  @doc """
  Loads configuration from an env lookup (`System.get_env/1` by default).

  Fails when `FACILITATOR_URL` is missing or when no catalog route resolves
  to a configured payee, mirroring the TypeScript/Python e2e servers.
  """
  @spec load(Catalog.env(), keyword()) :: {:ok, t()} | {:error, String.t()}
  def load(env \\ &System.get_env/1, opts \\ []) do
    with {:ok, facilitator_url} <- fetch_facilitator_url(env),
         {:ok, port} <- fetch_port(env),
         {:ok, routes} <- fetch_routes(env) do
      sdk_paths = Enum.map(Catalog.sdk_routes(env), & &1["path"])
      resolved_paths = MapSet.new(routes, & &1.path)

      unconfigured =
        for path <- sdk_paths,
            not MapSet.member?(resolved_paths, path),
            payload = Catalog.unconfigured_error(path, env),
            into: %{} do
          {path, payload}
        end

      {:ok,
       %__MODULE__{
         port: port,
         facilitator_url: facilitator_url,
         routes: routes,
         unconfigured: unconfigured,
         stopper: Keyword.get(opts, :stopper, fn -> System.stop(0) end)
       }}
    end
  end

  defp fetch_facilitator_url(env) do
    case env.("FACILITATOR_URL") do
      url when is_binary(url) and url != "" -> {:ok, url}
      _missing -> {:error, "FACILITATOR_URL environment variable is required"}
    end
  end

  defp fetch_port(env) do
    case env.("PORT") do
      nil ->
        {:ok, @default_port}

      value ->
        case Integer.parse(value) do
          {port, ""} when port >= 0 -> {:ok, port}
          _invalid -> {:error, "PORT must be an integer, got: #{value}"}
        end
    end
  end

  defp fetch_routes(env) do
    case Catalog.resolve_routes(env) do
      [] ->
        {:error,
         "At least one SERVER_*_ADDRESS for an Elixir catalog network is required " <>
           "(no catalog route resolved to a configured payee)"}

      routes ->
        {:ok, routes}
    end
  end
end
