import { verboseLog } from '../logger';
import { waitForHealth } from '../health';
import type { FacilitatorConfig } from './generic-facilitator';
import type { NetworkSet } from '../networks/networks';

interface Facilitator {
  start: (config: FacilitatorConfig) => Promise<void>;
  health: () => Promise<{ success: boolean }>;
  getUrl: () => string;
  stop: () => Promise<void>;
}

/**
 * Manages the async lifecycle of a facilitator process: start, health-check,
 * ready-gate, and stop.
 */
export class FacilitatorManager {
  private facilitator: Facilitator;
  private port: number;
  private readyPromise: Promise<string | null>;
  private url: string | null = null;

  constructor(facilitator: Facilitator, port: number, networks: NetworkSet) {
    this.facilitator = facilitator;
    this.port = port;

    // Start facilitator and health checks asynchronously
    this.readyPromise = this.startAndWaitForHealth(networks);
  }

  private async startAndWaitForHealth(networks: NetworkSet): Promise<string | null> {
    verboseLog(`  🏛️ Starting facilitator on port ${this.port}...`);

    await this.facilitator.start({
      port: this.port,
      networks,
    });

    const healthy = await waitForHealth(
      () => this.facilitator.health(),
      { label: 'Facilitator' },
    );

    if (healthy) {
      this.url = this.facilitator.getUrl();
      return this.url;
    }
    return null;
  }

  async ready(): Promise<string | null> {
    return this.readyPromise;
  }

  getProxy(): Facilitator {
    return this.facilitator;
  }

  async stop(): Promise<void> {
    if (this.facilitator) {
      await this.facilitator.stop();
    }
  }
}
