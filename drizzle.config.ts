import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/shared/database/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: 'yinliu.db',
  },
});
