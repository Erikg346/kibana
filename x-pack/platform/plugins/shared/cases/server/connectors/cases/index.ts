/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  AlertingConnectorFeatureId,
  UptimeConnectorFeatureId,
  SecurityConnectorFeatureId,
} from '@kbn/actions-plugin/common';
import type { SubActionConnectorType } from '@kbn/actions-plugin/server/sub_action_framework/types';
import type { KibanaRequest } from '@kbn/core-http-server';
import type { Logger, SavedObjectsClientContract } from '@kbn/core/server';
import type { ConnectorAdapter } from '@kbn/alerting-plugin/server';
import { ATTACK_DISCOVERY_SCHEDULES_ALERT_TYPE_ID } from '@kbn/elastic-assistant-common';
import { CasesConnector } from './cases_connector';
import { DEFAULT_MAX_OPEN_CASES } from './constants';
import {
  CASES_CONNECTOR_ID,
  CASES_CONNECTOR_TITLE,
  SECURITY_SOLUTION_OWNER,
} from '../../../common/constants';
import { getOwnerFromRuleConsumerProducer } from '../../../common/utils/owner';

import type {
  CasesConnectorConfig,
  CasesConnectorParams,
  CasesConnectorRuleActionParams,
  CasesConnectorSecrets,
  CasesGroupedAlerts,
} from './types';
import {
  CasesConnectorConfigSchema,
  CasesConnectorRuleActionParamsSchema,
  CasesConnectorSecretsSchema,
} from './schema';
import type { CasesClient } from '../../client';
import { constructRequiredKibanaPrivileges } from './utils';
import { ATTACK_DISCOVERY_MAX_OPEN_CASES, groupAttackDiscoveryAlerts } from './attack_discovery';

interface GetCasesConnectorTypeArgs {
  getCasesClient: (request: KibanaRequest) => Promise<CasesClient>;
  getUnsecuredSavedObjectsClient: (
    request: KibanaRequest,
    savedObjectTypes: string[]
  ) => Promise<SavedObjectsClientContract>;
  getSpaceId: (request?: KibanaRequest) => string;
  isServerlessSecurity?: boolean;
}

export const getCasesConnectorType = ({
  getCasesClient,
  getSpaceId,
  getUnsecuredSavedObjectsClient,
  isServerlessSecurity,
}: GetCasesConnectorTypeArgs): SubActionConnectorType<
  CasesConnectorConfig,
  CasesConnectorSecrets
> => ({
  id: CASES_CONNECTOR_ID,
  name: CASES_CONNECTOR_TITLE,
  getService: (params) =>
    new CasesConnector({
      casesParams: { getCasesClient, getSpaceId, getUnsecuredSavedObjectsClient },
      connectorParams: params,
    }),
  schema: {
    config: CasesConnectorConfigSchema,
    secrets: CasesConnectorSecretsSchema,
  },
  supportedFeatureIds: [
    UptimeConnectorFeatureId,
    AlertingConnectorFeatureId,
    SecurityConnectorFeatureId,
  ],
  minimumLicenseRequired: 'platinum' as const,
  isSystemActionType: true,
  getKibanaPrivileges: ({ params } = { params: { subAction: 'run', subActionParams: {} } }) => {
    if (!params?.subActionParams?.owner) {
      throw new Error('Cannot authorize cases. Owner is not defined in the subActionParams.');
    }

    const owner = isServerlessSecurity
      ? SECURITY_SOLUTION_OWNER
      : (params?.subActionParams?.owner as string);

    return constructRequiredKibanaPrivileges(owner);
  },
});

export const getCasesConnectorAdapter = ({
  isServerlessSecurity,
  logger,
}: {
  isServerlessSecurity?: boolean;
  logger: Logger;
}): ConnectorAdapter<CasesConnectorRuleActionParams, CasesConnectorParams> => {
  return {
    connectorTypeId: CASES_CONNECTOR_ID,
    ruleActionParamsSchema: CasesConnectorRuleActionParamsSchema,
    buildActionParams: ({ alerts, rule, params, ruleUrl }) => {
      const caseAlerts = [...alerts.new.data, ...alerts.ongoing.data];

      /**
       * We handle attack discovery alerts differently than other alerts and group
       * their building block SIEM alerts that led to each attack separately.
       */
      let internallyManagedAlerts = false;
      let groupedAlerts: CasesGroupedAlerts[] | null = null;
      let maximumCasesToOpen = DEFAULT_MAX_OPEN_CASES;
      if (rule.ruleTypeId === ATTACK_DISCOVERY_SCHEDULES_ALERT_TYPE_ID) {
        try {
          groupedAlerts = groupAttackDiscoveryAlerts(caseAlerts);
          internallyManagedAlerts = true;
          maximumCasesToOpen = ATTACK_DISCOVERY_MAX_OPEN_CASES;
        } catch (error) {
          logger.error(
            `Could not setup grouped Attack Discovery alerts, because of error: ${error}`
          );
        }
      }

      const owner = getOwnerFromRuleConsumerProducer({
        consumer: rule.consumer,
        producer: rule.producer,
        isServerlessSecurity,
      });

      const subActionParams = {
        alerts: caseAlerts,
        rule: { id: rule.id, name: rule.name, tags: rule.tags, ruleUrl: ruleUrl ?? null },
        groupingBy: params.subActionParams.groupingBy,
        groupedAlerts,
        owner,
        reopenClosedCases: params.subActionParams.reopenClosedCases,
        timeWindow: params.subActionParams.timeWindow,
        maximumCasesToOpen,
        templateId: params.subActionParams.templateId,
        internallyManagedAlerts,
      };

      return { subAction: 'run', subActionParams };
    },
    getKibanaPrivileges: ({ consumer, producer }) => {
      const owner = getOwnerFromRuleConsumerProducer({ consumer, producer, isServerlessSecurity });
      return constructRequiredKibanaPrivileges(owner);
    },
  };
};
