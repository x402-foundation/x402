defmodule E2eServer.Application do
  @moduledoc """
  OTP application entrypoint.

  In normal operation (`mix run --no-halt`, as invoked by the harness's
  `run.sh`) it loads configuration from the environment, boots the server
  supervision tree, and prints the readiness banner. When configuration is
  invalid it prints the reason and halts with a non-zero status so the
  harness fails fast.

  In `:test`, `config :x402_e2e_server, start_server: false` disables the
  boot; the smoke test starts `E2eServer.Supervisor` itself.
  """

  use Application

  alias E2eServer.Config

  @impl Application
  def start(_type, _args) do
    if Application.get_env(:x402_e2e_server, :start_server, true) do
      start_server()
    else
      Supervisor.start_link([], strategy: :one_for_one, name: E2eServer.NoopSupervisor)
    end
  end

  defp start_server do
    case Config.load() do
      {:ok, config} ->
        case E2eServer.Supervisor.start_link(config) do
          {:ok, pid} ->
            E2eServer.Supervisor.print_banner(config)
            {:ok, pid}

          {:error, reason} ->
            {:error, reason}
        end

      {:error, reason} ->
        IO.puts("Error: #{reason}")
        System.halt(1)
    end
  end
end
