/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { Plugin, CoreSetup, CoreStart, ICustomClusterClient } from '@kbn/core/server';

export class ElasticsearchClientPlugin implements Plugin {
  private client?: ICustomClusterClient;

  public setup(core: CoreSetup) {
    const router = core.http.createRouter();
    router.get(
      {
        path: '/api/elasticsearch_client_plugin/context/ping',
        security: {
          authz: {
            enabled: false,
            reason: 'This route is opted out from authorization',
          },
        },
        validate: false,
      },
      async (context, req, res) => {
        const esClient = (await context.core).elasticsearch.client;
        const body = await esClient.asInternalUser.ping();
        return res.ok({ body: JSON.stringify(body) });
      }
    );
    router.get(
      {
        path: '/api/elasticsearch_client_plugin/contract/ping',
        security: {
          authz: {
            enabled: false,
            reason: 'This route is opted out from authorization',
          },
        },
        validate: false,
      },
      async (context, req, res) => {
        const [coreStart] = await core.getStartServices();
        const body = await coreStart.elasticsearch.client.asInternalUser.ping();
        return res.ok({ body: JSON.stringify(body) });
      }
    );
    router.get(
      {
        path: '/api/elasticsearch_client_plugin/custom_client/ping',
        security: {
          authz: {
            enabled: false,
            reason: 'This route is opted out from authorization',
          },
        },
        validate: false,
      },
      async (context, req, res) => {
        const body = await this.client!.asInternalUser.ping();
        return res.ok({ body: JSON.stringify(body) });
      }
    );
  }

  public start(core: CoreStart) {
    this.client = core.elasticsearch.createClient('my-custom-client-test');
  }

  public stop() {}
}
