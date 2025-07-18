/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { uniq } from 'lodash';
import { lazy } from 'react';
import { i18n } from '@kbn/i18n';
import { EuiSelectOption } from '@elastic/eui';
import { InvalidEmailReason } from '@kbn/actions-plugin/common';
import type {
  ActionTypeModel as ConnectorTypeModel,
  GenericValidationResult,
} from '@kbn/triggers-actions-ui-plugin/public/types';
import { EmailActionParams, EmailConfig, EmailSecrets } from '../types';
import { RegistrationServices } from '..';
import { serviceParamValueToKbnSettingMap as emailKbnSettings } from '../../../common/email/constants';

export const emailServices: Array<EuiSelectOption & { 'kbn-setting-value': string }> = [
  {
    text: i18n.translate('xpack.stackConnectors.components.email.gmailServerTypeLabel', {
      defaultMessage: 'Gmail',
    }),
    value: 'gmail',
    ['kbn-setting-value']: emailKbnSettings.gmail,
  },
  {
    text: i18n.translate('xpack.stackConnectors.components.email.outlookServerTypeLabel', {
      defaultMessage: 'Outlook',
    }),
    value: 'outlook365',
    ['kbn-setting-value']: emailKbnSettings.outlook365,
  },
  {
    text: i18n.translate('xpack.stackConnectors.components.email.amazonSesServerTypeLabel', {
      defaultMessage: 'Amazon SES',
    }),
    value: 'ses',
    ['kbn-setting-value']: emailKbnSettings.ses,
  },
  {
    text: i18n.translate('xpack.stackConnectors.components.email.elasticCloudServerTypeLabel', {
      defaultMessage: 'Elastic Cloud',
    }),
    value: 'elastic_cloud',
    ['kbn-setting-value']: emailKbnSettings.elastic_cloud,
  },
  {
    text: i18n.translate('xpack.stackConnectors.components.email.exchangeServerTypeLabel', {
      defaultMessage: 'MS Exchange Server',
    }),
    value: 'exchange_server',
    ['kbn-setting-value']: emailKbnSettings.exchange_server,
  },
  {
    text: i18n.translate('xpack.stackConnectors.components.email.otherServerTypeLabel', {
      defaultMessage: 'Other',
    }),
    value: 'other',
    ['kbn-setting-value']: emailKbnSettings.other,
  },
];

// Return the current service regardless of its enabled state to allow users to:
// 1. View the current service in the dropdown UI
// 2. Update the service configuration if needed
// Note: The connector update endpoint will reject updates where the service
// remains unchanged but is disabled.
export function getEmailServices(
  isCloudEnabled: boolean,
  enabledEmailsServices: string[],
  currentService?: string
): Array<EuiSelectOption & { 'kbn-setting-value': string }> {
  const allEmailServices = isCloudEnabled
    ? emailServices
    : emailServices.filter((service) => service.value !== 'elastic_cloud');

  if (enabledEmailsServices.includes('*')) {
    return allEmailServices;
  }

  return allEmailServices.filter(
    (service) =>
      service.value === currentService ||
      enabledEmailsServices.includes(service['kbn-setting-value'])
  );
}

export function getConnectorType(
  services: RegistrationServices
): ConnectorTypeModel<EmailConfig, EmailSecrets, EmailActionParams> {
  return {
    id: '.email',
    iconClass: 'email',
    selectMessage: i18n.translate('xpack.stackConnectors.components.email.selectMessageText', {
      defaultMessage: 'Send email from your server.',
    }),
    actionTypeTitle: i18n.translate('xpack.stackConnectors.components.email.connectorTypeTitle', {
      defaultMessage: 'Send to email',
    }),
    validateParams: async (
      actionParams: EmailActionParams
    ): Promise<GenericValidationResult<EmailActionParams>> => {
      const translations = await import('./translations');
      const errors = {
        to: new Array<string>(),
        cc: new Array<string>(),
        bcc: new Array<string>(),
        message: new Array<string>(),
        subject: new Array<string>(),
      };
      const validationResult = { errors };

      if (!actionParams.message?.length) {
        errors.message.push(translations.MESSAGE_REQUIRED);
      }
      if (!actionParams.subject?.length) {
        errors.subject.push(translations.SUBJECT_REQUIRED);
      }

      const toEmails = getToFields(actionParams);
      const ccEmails = getCcFields(actionParams);
      const bccEmails = getBccFields(actionParams);

      if (toEmails.length === 0 && ccEmails.length === 0 && bccEmails.length === 0) {
        const errorText = translations.TO_CC_REQUIRED;
        errors.to.push(errorText);
        errors.cc.push(errorText);
        errors.bcc.push(errorText);
      }

      const allEmails = uniq(toEmails.concat(ccEmails).concat(bccEmails));
      const validatedEmails = services.validateEmailAddresses(allEmails, {
        treatMustacheTemplatesAsValid: true,
      });

      const toEmailSet = new Set(toEmails);
      const ccEmailSet = new Set(ccEmails);
      const bccEmailSet = new Set(bccEmails);

      for (const validated of validatedEmails) {
        if (!validated.valid) {
          const email = validated.address;
          const message =
            validated.reason === InvalidEmailReason.notAllowed
              ? translations.getNotAllowedEmailAddress(email)
              : translations.getInvalidEmailAddress(email);

          if (toEmailSet.has(email)) errors.to.push(message);
          if (ccEmailSet.has(email)) errors.cc.push(message);
          if (bccEmailSet.has(email)) errors.bcc.push(message);
        }
      }

      return validationResult;
    },
    actionConnectorFields: lazy(() => import('./email_connector')),
    actionParamsFields: lazy(() => import('./email_params')),
  };
}

function getToFields(actionParams: EmailActionParams): string[] {
  if (!(actionParams.to instanceof Array)) return [];
  return actionParams.to;
}

function getCcFields(actionParams: EmailActionParams): string[] {
  if (!(actionParams.cc instanceof Array)) return [];
  return actionParams.cc;
}

function getBccFields(actionParams: EmailActionParams): string[] {
  if (!(actionParams.bcc instanceof Array)) return [];
  return actionParams.bcc;
}
