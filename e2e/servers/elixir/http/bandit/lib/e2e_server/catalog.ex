defmodule E2eServer.Catalog do
  @moduledoc """
  Mechanisms catalog loader for the Elixir e2e resource server.

  SSOT is `e2e/config/mechanisms_global.json` plus one
  `e2e/config/mechanisms_<id>.json` per network, exactly as read by the
  TypeScript (`servers/typescript/catalog.ts`), Python
  (`servers/python/catalog.py`), and Go (`servers/go/catalog.go`) resource
  servers. Route paths, payment requirements, and prices all come from there.

  The catalog directory is resolved from `E2E_MECHANISMS_CATALOG` (injected by
  the harness), then by walking up from the working directory looking for
  `config/mechanisms_global.json` (running standalone from inside `e2e/`), and
  finally from the bundled `priv/catalog` fixture so the component can run its
  local smoke test without a foundation checkout.

  Routes are selected by `sdks` membership (`"elixir"`), then narrowed by the
  harness exclusions (`E2E_EXCLUDE_SCHEMES` / `E2E_EXCLUDE_NETWORKS`) and by a
  capability guard for what the Elixir SDK supports today: `exact`/`upto`
  schemes, the `authorization` payment flow, and the `eip3009` asset transfer
  method on EVM.
  """

  @sdk "elixir"
  @protected_route_message "Protected endpoint accessed successfully"

  @supported_schemes ~w(exact upto)
  @supported_transfer_methods [nil, "eip3009"]
  @supported_payment_flows [nil, "authorization"]

  # Default USD-pegged assets per CAIP-2 network, mirroring the TypeScript
  # SDK's DEFAULT_ASSETS table (typescript/packages/mechanisms/evm).
  @default_assets %{
    "eip155:84532" => %{
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      name: "USDC",
      version: "2",
      decimals: 6
    },
    "eip155:8453" => %{
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      name: "USD Coin",
      version: "2",
      decimals: 6
    }
  }

  @typedoc "Env lookup function (`System.get_env/1` shaped)."
  @type env :: (String.t() -> String.t() | nil)

  @typedoc "One catalog route the Elixir SDK can serve, with env-dependent values resolved."
  @type resolved_route :: %{
          path: String.t(),
          network_id: String.t(),
          scheme: String.t(),
          network: String.t(),
          pay_to: String.t(),
          amount: String.t(),
          asset: String.t(),
          extra: %{optional(String.t()) => String.t()},
          description: String.t()
        }

  @doc "Fixed success body message for every paid route."
  @spec protected_route_message() :: String.t()
  def protected_route_message, do: @protected_route_message

  @doc """
  Loads the raw catalog: `%{networks: %{id => file}, routes: %{path => route}}`.

  Every route carries its `"network"` (the catalog file id).
  """
  @spec load(env()) :: %{networks: map(), routes: map()}
  def load(env \\ &System.get_env/1) do
    dir = catalog_dir(env)

    network_files =
      dir
      |> File.ls!()
      |> Enum.filter(&Regex.match?(~r/^mechanisms_.+\.json$/, &1))
      |> Enum.reject(&(&1 == "mechanisms_global.json"))
      |> Enum.sort()

    {networks, routes} =
      Enum.reduce(network_files, {%{}, %{}}, fn file_name, {networks, routes} ->
        network_id =
          file_name
          |> String.replace_prefix("mechanisms_", "")
          |> String.replace_suffix(".json", "")

        data = read_json!(Path.join(dir, file_name))

        routes =
          Enum.reduce(Map.get(data, "routes", %{}), routes, fn {path, definition}, acc ->
            if Map.has_key?(acc, path) do
              raise "Duplicate route path across mechanisms catalog files: #{path}"
            end

            Map.put(acc, path, Map.put(definition, "network", network_id))
          end)

        {Map.put(networks, network_id, data), routes}
      end)

    %{networks: networks, routes: routes}
  end

  @doc """
  Catalog routes this SDK lists (`sdks` contains `"elixir"`), after harness
  exclusions and the SDK capability guard. Sorted by path for stable output.
  """
  @spec sdk_routes(env()) :: [map()]
  def sdk_routes(env \\ &System.get_env/1) do
    %{routes: routes} = load(env)
    excluded_schemes = split_env(env.("E2E_EXCLUDE_SCHEMES"))
    excluded_networks = split_env(env.("E2E_EXCLUDE_NETWORKS"))

    routes
    |> Enum.filter(fn {_path, route} -> @sdk in Map.get(route, "sdks", []) end)
    |> Enum.reject(fn {_path, route} ->
      route["scheme"] in excluded_schemes or route["network"] in excluded_networks
    end)
    |> Enum.filter(fn {path, route} -> supported_route?(path, route) end)
    |> Enum.map(fn {path, route} -> Map.put(route, "path", path) end)
    |> Enum.sort_by(& &1["path"])
  end

  @doc """
  Resolves every servable route against a server process environment.

  Routes whose network has no configured `SERVER_${ID}_ADDRESS` payee are
  dropped, so the server only advertises what it can actually settle —
  mirroring `resolvePaymentRoutes` in the harness.
  """
  @spec resolve_routes(env()) :: [resolved_route()]
  def resolve_routes(env \\ &System.get_env/1) do
    catalog = load(env)

    env
    |> sdk_routes()
    |> Enum.flat_map(fn route ->
      network_id = route["network"]

      case env.(server_address_env_key(network_id)) do
        pay_to when is_binary(pay_to) and pay_to != "" ->
          caip2 = network_caip2(catalog, network_id, env)

          case resolve_price(route, caip2) do
            {:ok, amount, asset, extra} ->
              [
                %{
                  path: route["path"],
                  network_id: network_id,
                  scheme: route["scheme"],
                  network: caip2,
                  pay_to: pay_to,
                  amount: amount,
                  asset: asset,
                  extra: extra,
                  description: route_description(route)
                }
              ]

            {:error, reason} ->
              log_skip(route["path"], reason)
              []
          end

        _missing ->
          []
      end
    end)
  end

  @doc """
  Returns the 501 payload for a catalog route path whose network payee is not
  configured, or `nil` when the path is not a known route (or is configured).

  Mirrors the unconfigured-network middleware of the Python e2e servers.
  """
  @spec unconfigured_error(String.t(), env()) :: map() | nil
  def unconfigured_error(path, env \\ &System.get_env/1) do
    case Enum.find(sdk_routes(env), &(&1["path"] == path)) do
      nil ->
        nil

      route ->
        env_key = server_address_env_key(route["network"])

        case env.(env_key) do
          value when is_binary(value) and value != "" ->
            nil

          _missing ->
            %{
              "error" => "#{String.upcase(route["network"])} payments not configured",
              "message" => "#{env_key} environment variable is not set"
            }
        end
    end
  end

  @doc "Server payee address env key for a network id, by fixed naming convention."
  @spec server_address_env_key(String.t()) :: String.t()
  def server_address_env_key(network_id), do: "SERVER_#{String.upcase(network_id)}_ADDRESS"

  # -- Route support -----------------------------------------------------------

  defp supported_route?(path, route) do
    supported =
      route["scheme"] in @supported_schemes and
        route["assetTransferMethod"] in @supported_transfer_methods and
        route["paymentFlow"] in @supported_payment_flows

    unless supported do
      log_skip(
        path,
        "unsupported combination (scheme=#{route["scheme"]}, " <>
          "assetTransferMethod=#{route["assetTransferMethod"] || "-"}, " <>
          "paymentFlow=#{route["paymentFlow"] || "authorization"})"
      )
    end

    supported
  end

  # -- Network / price resolution ---------------------------------------------

  defp network_caip2(catalog, network_id, env) do
    case env.("#{String.upcase(network_id)}_NETWORK") do
      value when is_binary(value) and value != "" ->
        value

      _missing ->
        get_in(catalog.networks, [network_id, "testnet", "caip2"]) ||
          raise "Catalog network #{network_id} has no testnet.caip2"
    end
  end

  # USD-denominated prices are converted against the network's default
  # USD-pegged asset (the same convention the TS/Python/Go SDKs apply).
  defp resolve_price(%{"price" => %{"usd" => usd}}, caip2) do
    with {:ok, asset_info} <- default_asset(caip2),
         {:ok, amount} <- usd_to_atomic(usd, asset_info.decimals) do
      {:ok, amount, asset_info.asset,
       %{"name" => asset_info.name, "version" => asset_info.version}}
    end
  end

  defp resolve_price(%{"price" => %{"amount" => amount, "asset" => asset}}, _caip2)
       when is_binary(amount) and is_binary(asset) do
    {:ok, amount, asset, %{}}
  end

  defp resolve_price(%{"price" => price}, _caip2) do
    {:error, "unsupported price spec #{inspect(price)}"}
  end

  defp default_asset(caip2) do
    case Map.fetch(@default_assets, caip2) do
      {:ok, info} -> {:ok, info}
      :error -> {:error, "no default USD asset known for network #{caip2}"}
    end
  end

  # "$0.001" with 6 decimals -> "1000". Integer string math, no floats.
  defp usd_to_atomic("$" <> decimal, decimals), do: usd_to_atomic(decimal, decimals)

  defp usd_to_atomic(decimal, decimals) do
    {int_part, frac_part} =
      case String.split(decimal, ".", parts: 2) do
        [int_part] -> {int_part, ""}
        [int_part, frac_part] -> {int_part, frac_part}
      end

    with true <- Regex.match?(~r/^\d*$/, int_part),
         true <- Regex.match?(~r/^\d*$/, frac_part),
         true <- int_part != "" or frac_part != "",
         frac_scaled = String.slice(String.pad_trailing(frac_part, decimals, "0"), 0, decimals),
         true <- String.length(frac_part) <= decimals do
      int_value = String.to_integer("0" <> int_part)
      frac_value = String.to_integer("0" <> frac_scaled)
      {:ok, Integer.to_string(int_value * pow10(decimals) + frac_value)}
    else
      _invalid -> {:error, "cannot convert USD price #{inspect(decimal)} to atomic units"}
    end
  end

  defp pow10(exponent), do: Integer.pow(10, exponent)

  # -- Descriptions ------------------------------------------------------------

  defp route_description(route) do
    label = String.upcase(route["network"])
    scheme = if route["scheme"] == "exact", do: "", else: "#{route["scheme"]} "
    transfer = if route["assetTransferMethod"], do: "#{route["assetTransferMethod"]} ", else: ""
    "Protected #{scheme}#{transfer}endpoint on #{label}"
  end

  # -- Catalog directory -------------------------------------------------------

  defp catalog_dir(env) do
    case env.("E2E_MECHANISMS_CATALOG") do
      dir when is_binary(dir) and dir != "" ->
        if File.dir?(dir) do
          dir
        else
          raise "E2E_MECHANISMS_CATALOG does not point at a directory: #{dir}"
        end

      _missing ->
        find_upwards(File.cwd!()) || bundled_catalog_dir()
    end
  end

  defp find_upwards(dir) do
    candidate = Path.join(dir, "config")

    cond do
      File.regular?(Path.join(candidate, "mechanisms_global.json")) -> candidate
      Path.dirname(dir) == dir -> nil
      true -> find_upwards(Path.dirname(dir))
    end
  end

  defp bundled_catalog_dir do
    dir = Application.app_dir(:x402_e2e_server, "priv/catalog")

    if File.regular?(Path.join(dir, "mechanisms_global.json")) do
      dir
    else
      raise "Could not locate a mechanisms catalog " <>
              "(set E2E_MECHANISMS_CATALOG or run from inside e2e/)"
    end
  end

  # -- Helpers -----------------------------------------------------------------

  defp read_json!(path) do
    path
    |> File.read!()
    |> Jason.decode!()
  end

  defp split_env(nil), do: []

  defp split_env(value) do
    value
    |> String.split(",")
    |> Enum.map(&String.trim/1)
    |> Enum.reject(&(&1 == ""))
  end

  defp log_skip(path, reason) do
    IO.puts("  skipping catalog route #{path}: #{reason}")
  end
end
