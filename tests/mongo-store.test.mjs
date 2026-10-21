import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import { MongoStore } from '../src/mongo-store.js';

test('MongoStore generates distinct UUIDs for upserts with a null document scope', async () => {
  const schemas = new Map();
  const connection = {
    model(name, schema) {
      schemas.set(name, schema);
      return { init: async () => {} };
    },
  };
  const originalCreateConnection = mongoose.createConnection;
  try {
    mongoose.createConnection = () => ({ asPromise: async () => connection });
    await new MongoStore().connect('mongodb://unused.invalid/test');
  } finally {
    mongoose.createConnection = originalCreateConnection;
  }

  const generated = new Set();
  for (const name of ['Code', 'Prize', 'Admin']) {
    const idPath = schemas.get(name).path('_id');
    for (let attempt = 0; attempt < 2; attempt++) {
      // Mongoose uses this null scope to apply defaults during an upsert.
      const id = idPath.getDefault(null, true);
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, `${name} generates a UUID v4`);
      assert.ok(!generated.has(id), `${name} generates a fresh UUID`);
      generated.add(id);
    }
  }
});
