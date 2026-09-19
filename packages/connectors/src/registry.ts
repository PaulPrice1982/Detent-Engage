import type { CrmConnector } from './contract.js';
import type { HttpClient } from './http.js';
import { HubSpotConnector } from './connectors/hubspot.js';
import { SalesforceConnector } from './connectors/salesforce.js';
import { PipedriveConnector } from './connectors/pipedrive.js';
import { ZohoConnector } from './connectors/zoho.js';
import { DynamicsConnector } from './connectors/dynamics.js';
import { SandboxConnector } from './connectors/sandbox.js';

/**
 * Connector registry. Tier 1 is hand-built on a common contract; the Tier 3
 * long tail is served by a pass-through unified API behind the same interface,
 * so nothing upstream can tell the difference (section 33.3).
 */
export class ConnectorRegistry {
  private readonly connectors = new Map<string, CrmConnector>();

  constructor(http?: HttpClient) {
    if (http) {
      this.register(new HubSpotConnector(http));
      this.register(new SalesforceConnector(http));
      this.register(new PipedriveConnector(http));
      this.register(new ZohoConnector(http));
      this.register(new DynamicsConnector(http));
    }
  }

  register(connector: CrmConnector): void {
    this.connectors.set(connector.name, connector);
  }

  get(name: string): CrmConnector | undefined {
    return this.connectors.get(name);
  }

  list(): CrmConnector[] {
    return [...this.connectors.values()];
  }
}

export { SandboxConnector };
export { HubSpotConnector, SalesforceConnector, PipedriveConnector, ZohoConnector, DynamicsConnector };
