import type { VideoPollResponse } from './types.js'

const PORTRAIT_VERIFICATION_CODE = 'PORTRAIT_VERIFICATION_REQUIRED'
const DEFAULT_MESSAGE = '素材涉及真人隐私，需要进行真人认证'

export function parsePortraitVerificationResponse(
  result: any,
  httpStatus?: number,
): VideoPollResponse | null {
  const payload = result?.data?.data ?? result?.data ?? result ?? {}
  const error = payload?.error ?? result?.error ?? {}
  const status = String(payload?.status ?? result?.status ?? '').toLowerCase()
  const errorCode = error?.code ?? payload?.errorCode ?? result?.errorCode

  if (httpStatus !== 428 && status !== 'portrait_verification_required' && errorCode !== PORTRAIT_VERIFICATION_CODE) {
    return null
  }

  return {
    status: 'portrait_verification_required',
    error: error?.message || payload?.message || result?.message || DEFAULT_MESSAGE,
    errorCode: PORTRAIT_VERIFICATION_CODE,
    verificationId: error?.verificationId || payload?.verificationId || result?.verificationId,
    verificationUrl: error?.verificationUrl || payload?.verificationUrl || result?.verificationUrl,
    providerError: error?.providerError || payload?.providerError || result?.providerError,
  }
}
