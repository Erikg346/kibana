/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import React, { useCallback, useMemo } from 'react';
import type { EuiBasicTableColumn } from '@elastic/eui';
import { type CriteriaWithPagination } from '@elastic/eui';
import {
  EuiBasicTable,
  EuiFlexGroup,
  EuiFlexItem,
  EuiIcon,
  EuiToolTip,
  EuiLink,
  EuiText,
} from '@elastic/eui';
import { i18n } from '@kbn/i18n';
import { FormattedDate, FormattedMessage, FormattedRelative } from '@kbn/i18n-react';
import { css } from '@emotion/css';

import type { Agent, AgentPolicy } from '../../../../types';
import { isAgentUpgradeable } from '../../../../services';
import { AgentHealth } from '../../components';

import type { Pagination } from '../../../../hooks';
import { useAgentVersion } from '../../../../hooks';
import { useLink, useAuthz } from '../../../../hooks';

import { AgentPolicySummaryLine } from '../../../../../../components';
import { Tags } from '../../components/tags';
import type { AgentMetrics } from '../../../../../../../common/types';
import { formatAgentCPU, formatAgentMemory } from '../../services/agent_metrics';

import { AgentUpgradeStatus } from './agent_upgrade_status';

import { EmptyPrompt } from './empty_prompt';

const AGENTS_TABLE_FIELDS = {
  ACTIVE: 'active',
  HOSTNAME: 'local_metadata.host.hostname',
  POLICY: 'policy_id',
  METRICS: 'metrics',
  VERSION: 'local_metadata.elastic.agent.version',
  LAST_CHECKIN: 'last_checkin',
};

function safeMetadata(val: any) {
  if (typeof val !== 'string') {
    return '-';
  }
  return val;
}

interface Props {
  agents: Agent[];
  isLoading: boolean;
  agentPoliciesIndexedById: Record<string, AgentPolicy>;
  renderActions: (a: Agent) => JSX.Element;
  sortField: keyof Agent;
  sortOrder: 'asc' | 'desc';
  onSelectionChange: (agents: Agent[]) => void;
  selected: Agent[];
  showUpgradeable: boolean;
  totalAgents?: number;
  pagination: Pagination;
  onTableChange: (criteria: CriteriaWithPagination<Agent>) => void;
  pageSizeOptions: number[];
  isUsingFilter: boolean;
  setEnrollmentFlyoutState: (
    value: React.SetStateAction<{
      isOpen: boolean;
      selectedPolicyId?: string | undefined;
    }>
  ) => void;
  clearFilters: () => void;
  isCurrentRequestIncremented: boolean;
}

export const AgentListTable: React.FC<Props> = (props: Props) => {
  const {
    agents,
    isLoading,
    agentPoliciesIndexedById,
    renderActions,
    sortField,
    sortOrder,
    onTableChange,
    onSelectionChange,
    selected,
    totalAgents = 0,
    showUpgradeable,
    pagination,
    pageSizeOptions,
    isUsingFilter,
    setEnrollmentFlyoutState,
    clearFilters,
    isCurrentRequestIncremented,
  } = props;

  const authz = useAuthz();

  const { getHref } = useLink();
  const latestAgentVersion = useAgentVersion();

  const isAgentSelectable = useCallback(
    (agent: Agent) => {
      if (!agent.active) return false;
      if (!agent.policy_id) return true;

      const agentPolicy = agentPoliciesIndexedById[agent.policy_id];
      const isHosted = agentPolicy?.is_managed === true;
      return !isHosted;
    },
    [agentPoliciesIndexedById]
  );

  const agentsShown = useMemo(() => {
    return totalAgents
      ? showUpgradeable
        ? agents.filter((agent) => isAgentSelectable(agent) && isAgentUpgradeable(agent))
        : agents
      : [];
  }, [agents, isAgentSelectable, showUpgradeable, totalAgents]);

  const noItemsMessage =
    isLoading && isCurrentRequestIncremented ? (
      <FormattedMessage
        id="xpack.fleet.agentList.loadingAgentsMessage"
        defaultMessage="Loading agents…"
      />
    ) : isUsingFilter ? (
      <FormattedMessage
        id="xpack.fleet.agentList.noFilteredAgentsPrompt"
        defaultMessage="No agents found. {clearFiltersLink}"
        values={{
          clearFiltersLink: (
            <EuiLink onClick={() => clearFilters()}>
              <FormattedMessage
                id="xpack.fleet.agentList.clearFiltersLinkText"
                defaultMessage="Clear filters"
              />
            </EuiLink>
          ),
        }}
      />
    ) : (
      <EmptyPrompt
        hasFleetAddAgentsPrivileges={authz.fleet.addAgents}
        setEnrollmentFlyoutState={setEnrollmentFlyoutState}
      />
    );

  const sorting = {
    sort: {
      field: sortField,
      direction: sortOrder,
    },
  };

  const columns: Array<EuiBasicTableColumn<Agent>> = [
    {
      field: AGENTS_TABLE_FIELDS.ACTIVE,
      sortable: false,
      width: '85px',
      name: i18n.translate('xpack.fleet.agentList.statusColumnTitle', {
        defaultMessage: 'Status',
      }),
      render: (active: boolean, agent: any) => <AgentHealth agent={agent} />,
    },
    {
      field: AGENTS_TABLE_FIELDS.HOSTNAME,
      sortable: true,
      name: i18n.translate('xpack.fleet.agentList.hostColumnTitle', {
        defaultMessage: 'Host',
      }),
      width: '185px',
      render: (host: string, agent: Agent) => (
        <EuiFlexGroup gutterSize="none" direction="column">
          <EuiFlexItem grow={false}>
            <EuiLink href={getHref('agent_details', { agentId: agent.id })}>
              {safeMetadata(host)}
            </EuiLink>
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <Tags tags={agent.tags ?? []} color="subdued" size="xs" />
          </EuiFlexItem>
        </EuiFlexGroup>
      ),
    },
    {
      field: AGENTS_TABLE_FIELDS.POLICY,
      sortable: true,
      truncateText: true,
      name: i18n.translate('xpack.fleet.agentList.policyColumnTitle', {
        defaultMessage: 'Agent policy',
      }),
      width: '220px',
      render: (policyId: string, agent: Agent) => {
        const agentPolicy = agentPoliciesIndexedById[policyId];

        return (
          agentPolicy && (
            <AgentPolicySummaryLine direction="column" policy={agentPolicy} agent={agent} />
          )
        );
      },
    },

    {
      field: AGENTS_TABLE_FIELDS.METRICS,
      sortable: false,
      name: (
        <EuiToolTip
          content={
            <FormattedMessage
              id="xpack.fleet.agentList.cpuTooltip"
              defaultMessage="Average CPU usage in the last 5 minutes. This includes usage from the Agent and the component it supervises. Possible value ranges from 0 to (number of available CPU cores * 100)"
            />
          }
        >
          <span>
            <FormattedMessage id="xpack.fleet.agentList.cpuTitle" defaultMessage="CPU" />
            &nbsp;
            <EuiIcon type="info" />
          </span>
        </EuiToolTip>
      ),
      width: '75px',
      render: (metrics: AgentMetrics | undefined, agent: Agent) =>
        formatAgentCPU(
          agent.metrics,
          agent.policy_id ? agentPoliciesIndexedById[agent.policy_id] : undefined
        ),
    },
    {
      field: AGENTS_TABLE_FIELDS.METRICS,
      sortable: false,
      name: (
        <EuiToolTip
          content={
            <FormattedMessage
              id="xpack.fleet.agentList.memoryTooltip"
              defaultMessage="Average memory usage in the last 5 minutes"
            />
          }
        >
          <span>
            <FormattedMessage id="xpack.fleet.agentList.memoryTitle" defaultMessage="Memory" />
            &nbsp;
            <EuiIcon type="info" />
          </span>
        </EuiToolTip>
      ),
      width: '90px',
      render: (metrics: AgentMetrics | undefined, agent: Agent) =>
        formatAgentMemory(
          agent.metrics,
          agent.policy_id ? agentPoliciesIndexedById[agent.policy_id] : undefined
        ),
    },
    {
      field: AGENTS_TABLE_FIELDS.LAST_CHECKIN,
      sortable: true,
      name: i18n.translate('xpack.fleet.agentList.lastCheckinTitle', {
        defaultMessage: 'Last activity',
      }),
      width: '100px',
      render: (lastCheckin: string) =>
        lastCheckin ? (
          <EuiToolTip
            content={
              <FormattedMessage
                id="xpack.fleet.agentList.lastActivityTooltip"
                defaultMessage="Last checked in at {lastCheckin}"
                values={{
                  lastCheckin: (
                    <FormattedDate
                      value={lastCheckin}
                      year="numeric"
                      month="short"
                      day="2-digit"
                      timeZoneName="short"
                      hour="numeric"
                      minute="numeric"
                    />
                  ),
                }}
              />
            }
          >
            <FormattedRelative value={lastCheckin} />
          </EuiToolTip>
        ) : undefined,
    },
    {
      field: AGENTS_TABLE_FIELDS.VERSION,
      sortable: true,
      width: '220px',
      name: i18n.translate('xpack.fleet.agentList.versionTitle', {
        defaultMessage: 'Version',
      }),
      render: (version: string, agent: Agent) => (
        <EuiFlexGroup
          gutterSize="none"
          css={css`
            min-width: 0;
          `}
          direction="column"
        >
          <EuiFlexItem grow={false}>
            <EuiFlexGroup gutterSize="s" alignItems="center" wrap>
              <EuiFlexItem grow={false}>
                <EuiText size="s" className="eui-textNoWrap">
                  {safeMetadata(version)}
                </EuiText>
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <AgentUpgradeStatus
                  isAgentUpgradable={!!(isAgentSelectable(agent) && isAgentUpgradeable(agent))}
                  agent={agent}
                  latestAgentVersion={latestAgentVersion}
                />
              </EuiFlexItem>
            </EuiFlexGroup>
          </EuiFlexItem>
        </EuiFlexGroup>
      ),
    },
    {
      name: i18n.translate('xpack.fleet.agentList.actionsColumnTitle', {
        defaultMessage: 'Actions',
      }),
      actions: [
        {
          render: renderActions,
        },
      ],
      width: '100px',
    },
  ];

  return (
    <EuiBasicTable<Agent>
      className="fleet__agentList__table"
      data-test-subj="fleetAgentListTable"
      loading={isLoading}
      noItemsMessage={noItemsMessage}
      items={agentsShown}
      itemId="id"
      columns={columns}
      pagination={{
        pageIndex: pagination.currentPage - 1,
        pageSize: pagination.pageSize,
        totalItemCount: totalAgents,
        pageSizeOptions,
      }}
      selection={{
        selected,
        onSelectionChange,
        selectable: isAgentSelectable,
        selectableMessage: (selectable, agent) => {
          if (selectable) return '';
          if (!agent.active) {
            return 'This agent is not active';
          }
          if (agent.policy_id && agentPoliciesIndexedById[agent.policy_id].is_managed) {
            return 'This action is not available for agents enrolled in an externally managed agent policy';
          }
          return '';
        },
      }}
      onChange={onTableChange}
      sorting={sorting}
    />
  );
};
