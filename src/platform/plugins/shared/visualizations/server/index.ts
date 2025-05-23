/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { PluginConfigDescriptor, PluginInitializerContext } from '@kbn/core/server';
import { configSchema } from './config';

//  This exports static code and TypeScript types,
//  as well as, Kibana Platform `plugin()` initializer.

export const config: PluginConfigDescriptor<any> = {
  schema: configSchema,
  exposeToBrowser: {
    visualize_v2: { enabled: true },
  },
};

export async function plugin(initializerContext: PluginInitializerContext) {
  const { VisualizationsPlugin } = await import('./plugin');
  return new VisualizationsPlugin(initializerContext);
}

export type { VisualizationsServerSetup, VisualizationsServerStart } from './types';
