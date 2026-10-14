import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          testTimeout: 90_000,
          hookTimeout: 30_000,
          fileParallelism: false,
        },
      },
      {
        test: {
          name: 'integration-oci',
          include: ['test/integration/**/*.test.ts'],
          exclude: [
            'test/integration/oci.test.ts',
            'test/integration/oci-suite.test.ts',
            'test/integration/host-tools.test.ts',
          ],
          env: { SCREENS_TEST_BACKEND: 'oci' },
          testTimeout: 120_000,
          hookTimeout: 30_000,
          fileParallelism: false,
        },
      },
    ],
  },
})
