import { expect, test } from 'vitest'
import { chooseBackend } from '../../src/backend-choice.js'
import { RequestError } from '../../src/protocol.js'

test('CON-C2 on macOS create --backend xvnc is a usage error that says xvnc is Linux only', () => {
  const choose = () =>
    chooseBackend({ platform: 'darwin', requested: 'xvnc', configured: undefined })
  expect(choose).toThrow(RequestError)
  expect(choose).toThrow(/xvnc.*Linux only/)
  try {
    choose()
  } catch (error) {
    expect((error as RequestError).code).toBe('usage')
  }
})

test('the default backend is xvnc on Linux, oci on macOS, and the config can change the Linux default', () => {
  expect(chooseBackend({ platform: 'linux', requested: undefined, configured: undefined })).toBe(
    'xvnc',
  )
  expect(chooseBackend({ platform: 'darwin', requested: undefined, configured: undefined })).toBe(
    'oci',
  )
  expect(chooseBackend({ platform: 'linux', requested: undefined, configured: 'oci' })).toBe('oci')
  expect(chooseBackend({ platform: 'linux', requested: 'xvnc', configured: 'oci' })).toBe('xvnc')
  expect(chooseBackend({ platform: 'darwin', requested: undefined, configured: 'xvnc' })).toBe(
    'oci',
  )
})
