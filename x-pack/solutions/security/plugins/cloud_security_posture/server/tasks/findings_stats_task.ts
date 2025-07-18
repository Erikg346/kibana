/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { transformError } from '@kbn/securitysolution-es-utils';
import {
  RunContext,
  TaskManagerSetupContract,
  TaskManagerStartContract,
} from '@kbn/task-manager-plugin/server';
import type { SearchRequest } from '@elastic/elasticsearch/lib/api/types';
import { ElasticsearchClient } from '@kbn/core/server';
import { QueryDslQueryContainer } from '@kbn/data-views-plugin/common/types';
import {
  CDR_LATEST_NATIVE_MISCONFIGURATIONS_INDEX_ALIAS,
  CDR_LATEST_NATIVE_VULNERABILITIES_INDEX_PATTERN,
  VULNERABILITIES_SEVERITY,
} from '@kbn/cloud-security-posture-common';
import type { ISavedObjectsRepository, Logger } from '@kbn/core/server';
import { getMutedRulesFilterQuery } from '../routes/benchmark_rules/get_states/v1';
import { getSafePostureTypeRuntimeMapping } from '../../common/runtime_mappings/get_safe_posture_type_runtime_mapping';
import { getIdentifierRuntimeMapping } from '../../common/runtime_mappings/get_identifier_runtime_mapping';
import { FindingsStatsTaskResult, ScoreAggregationResponse, VulnSeverityAggs } from './types';
import {
  BENCHMARK_SCORE_INDEX_DEFAULT_NS,
  CSPM_FINDINGS_STATS_INTERVAL,
  INTERNAL_CSP_SETTINGS_SAVED_OBJECT_TYPE,
  VULN_MGMT_POLICY_TEMPLATE,
} from '../../common/constants';
import { scheduleTaskSafe, removeTaskSafe } from '../lib/task_manager_util';
import { CspServerPluginStartServices } from '../types';
import {
  stateSchemaByVersion,
  emptyState,
  type LatestTaskStateSchema,
  type TaskHealthStatus,
} from './task_state';
import { toBenchmarkMappingFieldKey } from '../lib/mapping_field_util';

const CSPM_FINDINGS_STATS_TASK_ID = 'cloud_security_posture-findings_stats';
const CSPM_FINDINGS_STATS_TASK_TYPE = 'cloud_security_posture-stats_task';

export async function scheduleFindingsStatsTask(
  taskManager: TaskManagerStartContract,
  logger: Logger
) {
  await scheduleTaskSafe(
    taskManager,
    {
      id: CSPM_FINDINGS_STATS_TASK_ID,
      taskType: CSPM_FINDINGS_STATS_TASK_TYPE,
      schedule: {
        interval: `${CSPM_FINDINGS_STATS_INTERVAL}m`,
      },
      state: emptyState,
      params: {},
    },
    logger
  );
}

export async function removeFindingsStatsTask(
  taskManager: TaskManagerStartContract,
  logger: Logger
) {
  await removeTaskSafe(taskManager, CSPM_FINDINGS_STATS_TASK_ID, logger);
}

export function setupFindingsStatsTask(
  taskManager: TaskManagerSetupContract,
  coreStartServices: CspServerPluginStartServices,
  logger: Logger
) {
  try {
    taskManager.registerTaskDefinitions({
      [CSPM_FINDINGS_STATS_TASK_TYPE]: {
        title: 'Aggregate latest findings index for score calculation',
        stateSchemaByVersion,
        createTaskRunner: taskRunner(coreStartServices, logger),
      },
    });
    logger.info(`Registered task successfully [Task: ${CSPM_FINDINGS_STATS_TASK_TYPE}]`);
  } catch (errMsg) {
    const error = transformError(errMsg);
    logger.error(
      `Task registration failed [Task: ${CSPM_FINDINGS_STATS_TASK_TYPE}] ${error.message}`
    );
  }
}

export function taskRunner(coreStartServices: CspServerPluginStartServices, logger: Logger) {
  return ({ taskInstance }: RunContext) => {
    const state = taskInstance.state as LatestTaskStateSchema;
    return {
      async run(): Promise<FindingsStatsTaskResult> {
        try {
          logger.info(`Runs task: ${CSPM_FINDINGS_STATS_TASK_TYPE}`);
          const startServices = await coreStartServices;
          const esClient = startServices[0].elasticsearch.client.asInternalUser;
          const encryptedSoClient = startServices[0].savedObjects.createInternalRepository([
            INTERNAL_CSP_SETTINGS_SAVED_OBJECT_TYPE,
          ]);

          const status = await aggregateLatestFindings(esClient, encryptedSoClient, logger);

          const updatedState: LatestTaskStateSchema = {
            runs: state.runs + 1,
            health_status: status,
          };
          return {
            state: updatedState,
          };
        } catch (errMsg) {
          const error = transformError(errMsg);
          logger.warn(`Error executing alerting health check task: ${error.message}`);
          const updatedState: LatestTaskStateSchema = {
            runs: state.runs + 1,
            health_status: 'error',
          };
          return {
            state: updatedState,
          };
        }
      },
    };
  };
}

const getScoreAggregationQuery = () => ({
  score_by_policy_template: {
    terms: {
      field: 'safe_posture_type',
    },
    aggs: {
      total_findings: {
        value_count: {
          field: 'result.evaluation',
        },
      },
      passed_findings: {
        filter: {
          term: {
            'result.evaluation': 'passed',
          },
        },
      },
      failed_findings: {
        filter: {
          term: {
            'result.evaluation': 'failed',
          },
        },
      },
      score_by_cluster_id: {
        terms: {
          field: 'asset_identifier',
        },
        aggs: {
          total_findings: {
            value_count: {
              field: 'result.evaluation',
            },
          },
          passed_findings: {
            filter: {
              term: {
                'result.evaluation': 'passed',
              },
            },
          },
          failed_findings: {
            filter: {
              term: {
                'result.evaluation': 'failed',
              },
            },
          },
        },
      },
      score_by_benchmark_id: {
        terms: {
          field: 'rule.benchmark.id',
        },
        aggs: {
          benchmark_versions: {
            terms: {
              field: 'rule.benchmark.version',
            },
            aggs: {
              total_findings: {
                value_count: {
                  field: 'result.evaluation',
                },
              },
              passed_findings: {
                filter: {
                  term: {
                    'result.evaluation': 'passed',
                  },
                },
              },
              failed_findings: {
                filter: {
                  term: {
                    'result.evaluation': 'failed',
                  },
                },
              },
            },
          },
        },
      },
    },
  },
});

const getScoreQuery = (filteredRules: QueryDslQueryContainer[]): SearchRequest => ({
  index: CDR_LATEST_NATIVE_MISCONFIGURATIONS_INDEX_ALIAS,
  size: 0,
  // creates the safe_posture_type and asset_identifier runtime fields
  runtime_mappings: { ...getIdentifierRuntimeMapping(), ...getSafePostureTypeRuntimeMapping() },
  query: {
    bool: {
      must: [
        {
          range: {
            '@timestamp': {
              gte: 'now-1d',
              lte: 'now',
            },
          },
        },
      ],
      must_not: filteredRules,
    },
  },
  aggs: {
    score_by_namespace: {
      terms: {
        field: 'data_stream.namespace',
      },
      aggs: getScoreAggregationQuery(),
    },
  },
});

const getVulnStatsTrendQuery = (): SearchRequest => ({
  index: CDR_LATEST_NATIVE_VULNERABILITIES_INDEX_PATTERN,
  size: 0,
  query: {
    match_all: {},
  },
  aggs: {
    critical: {
      filter: { term: { 'vulnerability.severity': VULNERABILITIES_SEVERITY.CRITICAL } },
    },
    high: {
      filter: { term: { 'vulnerability.severity': VULNERABILITIES_SEVERITY.HIGH } },
    },
    medium: {
      filter: { term: { 'vulnerability.severity': VULNERABILITIES_SEVERITY.MEDIUM } },
    },
    low: {
      filter: { term: { 'vulnerability.severity': VULNERABILITIES_SEVERITY.LOW } },
    },
    vulnerabilities_stats_by_cloud_account: {
      terms: {
        field: 'cloud.account.id',
      },
      aggs: {
        cloud_account_id: {
          terms: {
            field: 'cloud.account.id',
            size: 1,
          },
        },
        cloud_account_name: {
          terms: {
            field: 'cloud.account.name',
            size: 1,
          },
        },
        critical: {
          filter: { term: { 'vulnerability.severity': VULNERABILITIES_SEVERITY.CRITICAL } },
        },
        high: {
          filter: { term: { 'vulnerability.severity': VULNERABILITIES_SEVERITY.HIGH } },
        },
        medium: {
          filter: { term: { 'vulnerability.severity': VULNERABILITIES_SEVERITY.MEDIUM } },
        },
        low: {
          filter: { term: { 'vulnerability.severity': VULNERABILITIES_SEVERITY.LOW } },
        },
      },
    },
  },
});

const getFindingsScoresByNamespaceIndexingPromises = (
  esClient: ElasticsearchClient,
  scoresByNamespaceBuckets: ScoreAggregationResponse['score_by_namespace']['buckets'],
  isCustomScore: boolean
) => {
  return scoresByNamespaceBuckets.flatMap((namespaceBucket) => {
    const namespace = namespaceBucket.key || 'unspecified'; // default fallback if key is empty

    return namespaceBucket.score_by_policy_template.buckets.map((policyTemplateTrend) => {
      const clustersStats = Object.fromEntries(
        policyTemplateTrend.score_by_cluster_id.buckets.map((clusterStats) => {
          return [
            clusterStats.key,
            {
              total_findings: clusterStats.total_findings.value,
              passed_findings: clusterStats.passed_findings.doc_count,
              failed_findings: clusterStats.failed_findings.doc_count,
            },
          ];
        })
      );

      const benchmarkStats = Object.fromEntries(
        policyTemplateTrend.score_by_benchmark_id.buckets.map((benchmarkIdBucket) => {
          const benchmarkVersions = Object.fromEntries(
            benchmarkIdBucket.benchmark_versions.buckets.map((benchmarkVersionBucket) => {
              return [
                toBenchmarkMappingFieldKey(benchmarkVersionBucket.key),
                {
                  total_findings: benchmarkVersionBucket.total_findings.value,
                  passed_findings: benchmarkVersionBucket.passed_findings.doc_count,
                  failed_findings: benchmarkVersionBucket.failed_findings.doc_count,
                },
              ];
            })
          );

          return [benchmarkIdBucket.key, benchmarkVersions];
        })
      );

      return esClient.index({
        index: BENCHMARK_SCORE_INDEX_DEFAULT_NS,
        document: {
          policy_template: policyTemplateTrend.key,
          passed_findings: policyTemplateTrend.passed_findings.doc_count,
          failed_findings: policyTemplateTrend.failed_findings.doc_count,
          total_findings: policyTemplateTrend.total_findings.value,
          score_by_cluster_id: clustersStats,
          score_by_benchmark_id: benchmarkStats,
          is_enabled_rules_score: isCustomScore,
          namespace,
        },
      });
    });
  });
};

export const getVulnStatsTrendDocIndexingPromises = (
  esClient: ElasticsearchClient,
  vulnStatsAggs?: VulnSeverityAggs
) => {
  if (!vulnStatsAggs) return;

  const scoreByCloudAccount = Object.fromEntries(
    vulnStatsAggs.vulnerabilities_stats_by_cloud_account.buckets.map((accountScore) => {
      const cloudAccountId = accountScore.key;
      return [
        cloudAccountId,
        {
          cloudAccountId: accountScore.key,
          cloudAccountName: accountScore.cloud_account_name.buckets[0]?.key || '',
          critical: accountScore.critical.doc_count,
          high: accountScore.high.doc_count,
          medium: accountScore.medium.doc_count,
          low: accountScore.low.doc_count,
        },
      ];
    })
  );

  return esClient.index({
    index: BENCHMARK_SCORE_INDEX_DEFAULT_NS,
    document: {
      policy_template: VULN_MGMT_POLICY_TEMPLATE,
      critical: vulnStatsAggs.critical.doc_count,
      high: vulnStatsAggs.high.doc_count,
      medium: vulnStatsAggs.medium.doc_count,
      low: vulnStatsAggs.low.doc_count,
      vulnerabilities_stats_by_cloud_account: scoreByCloudAccount,
    },
  });
};

export const aggregateLatestFindings = async (
  esClient: ElasticsearchClient,
  encryptedSoClient: ISavedObjectsRepository,
  logger: Logger
): Promise<TaskHealthStatus> => {
  try {
    const startAggTime = performance.now();

    const rulesFilter = await getMutedRulesFilterQuery(encryptedSoClient);

    const customScoreIndexQueryResult = await esClient.search<unknown, ScoreAggregationResponse>(
      getScoreQuery(rulesFilter)
    );

    const fullScoreIndexQueryResult = await esClient.search<unknown, ScoreAggregationResponse>(
      getScoreQuery([])
    );

    const vulnStatsTrendIndexQueryResult = await esClient.search<unknown, VulnSeverityAggs>(
      getVulnStatsTrendQuery()
    );

    if (!customScoreIndexQueryResult.aggregations && !vulnStatsTrendIndexQueryResult.aggregations) {
      logger.warn(`No data found in latest findings index`);
      return 'warning';
    }

    const totalAggregationTime = performance.now() - startAggTime;
    logger.debug(
      `Executed aggregation query [Task: ${CSPM_FINDINGS_STATS_TASK_TYPE}] [Duration: ${Number(
        totalAggregationTime
      ).toFixed(2)}ms]`
    );

    const customScoresByNamespaceBuckets =
      customScoreIndexQueryResult.aggregations?.score_by_namespace.buckets || [];

    const fullScoresByNamespaceBuckets =
      fullScoreIndexQueryResult.aggregations?.score_by_namespace.buckets || [];

    const findingsCustomScoresByNamespaceDocIndexingPromises =
      getFindingsScoresByNamespaceIndexingPromises(esClient, customScoresByNamespaceBuckets, true);

    const findingsFullScoresByNamespaceDocIndexingPromises =
      getFindingsScoresByNamespaceIndexingPromises(esClient, fullScoresByNamespaceBuckets, false);

    const vulnStatsTrendDocIndexingPromises = getVulnStatsTrendDocIndexingPromises(
      esClient,
      vulnStatsTrendIndexQueryResult.aggregations
    );

    const startIndexTime = performance.now();

    // executing indexing commands
    await Promise.all(
      [
        findingsCustomScoresByNamespaceDocIndexingPromises,
        findingsFullScoresByNamespaceDocIndexingPromises,
        vulnStatsTrendDocIndexingPromises,
      ].filter(Boolean)
    );

    const totalIndexTime = Number(performance.now() - startIndexTime).toFixed(2);
    logger.debug(
      `Finished saving results [Task: ${CSPM_FINDINGS_STATS_TASK_TYPE}] [Duration: ${totalIndexTime}ms]`
    );

    const totalTaskTime = Number(performance.now() - startAggTime).toFixed(2);
    logger.debug(
      `Finished run ended [Task: ${CSPM_FINDINGS_STATS_TASK_TYPE}] [Duration: ${totalTaskTime}ms]`
    );

    return 'ok';
  } catch (errMsg) {
    const error = transformError(errMsg);
    logger.error(
      `Failure during task run [Task: ${CSPM_FINDINGS_STATS_TASK_TYPE}] ${error.message}`
    );
    logger.error(errMsg);
    return 'error';
  }
};
