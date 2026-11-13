defmodule E2eServer.Router do
  @moduledoc """
  Plug router for the e2e resource server.

  `X402.Plug.PaymentGate` runs before route dispatch with options compiled at
  boot (see `E2eServer.Supervisor`), so every paid catalog route is gated:

  * no `PAYMENT-SIGNATURE` header → 402 + `PAYMENT-REQUIRED`
  * verified + settled payment → the fixed success body + `PAYMENT-RESPONSE`

  Infra endpoints follow the harness conventions: `GET /health` and
  `POST /close` (graceful shutdown). Catalog routes whose network payee is
  not configured answer 501, mirroring the Python e2e servers.
  """

  use Plug.Router

  alias E2eServer.Catalog

  plug(:payment_gate)
  plug(:match)
  plug(:dispatch)

  @doc false
  def payment_gate(conn, _opts) do
    X402.Plug.PaymentGate.call(conn, :persistent_term.get({E2eServer, :gate}))
  end

  get "/health" do
    state = state()

    networks =
      state.routes
      |> Enum.map(fn route ->
        {route.network_id, %{"network" => route.network, "payee" => route.pay_to}}
      end)
      |> Map.new()

    body = %{
      "status" => "healthy",
      "timestamp" => timestamp(),
      "server" => "bandit",
      "networks" => networks
    }

    send_json(conn, 200, body)
  end

  post "/close" do
    state = state()

    Task.start(fn ->
      Process.sleep(100)
      state.stopper.()
    end)

    send_json(conn, 200, %{
      "message" => "Server shutting down gracefully",
      "timestamp" => timestamp()
    })
  end

  match _ do
    state = state()
    path = conn.request_path

    cond do
      conn.method == "GET" and MapSet.member?(state.paid_paths, path) ->
        send_json(conn, 200, %{
          "message" => Catalog.protected_route_message(),
          "timestamp" => timestamp()
        })

      payload = state.unconfigured[path] ->
        send_json(conn, 501, payload)

      true ->
        send_json(conn, 404, %{"error" => "Not found"})
    end
  end

  defp state, do: :persistent_term.get({E2eServer, :state})

  defp send_json(conn, status, body) do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(status, Jason.encode!(body))
  end

  defp timestamp, do: DateTime.to_iso8601(DateTime.utc_now())
end
