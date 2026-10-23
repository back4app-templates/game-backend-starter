// File: scripts/lib/schema.mjs · Node 22 ESM
// The schema (fields, class-level permissions, indexes) lives in cloud/config.js so that the Cloud function
// setupSchema (no master key on the client) and scripts/setup.mjs (master key, local server) apply the same
// definition. This module only re-exports it for the scripts.
import config from '../../cloud/config.js';

export const CLASSES = config.SCHEMA;
