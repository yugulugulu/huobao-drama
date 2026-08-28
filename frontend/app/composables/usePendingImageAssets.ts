const STORAGE_KEY = 'studio:pending-image-assets'
const MAX_PENDING_AGE_MS = 15 * 60 * 1000

export function usePendingImageAssets() {
  const pendingCharImageIds = useState<number[]>('pending-image-character-ids', () => [])
  const pendingSceneImageIds = useState<number[]>('pending-image-scene-ids', () => [])
  const pendingPropImageIds = useState<number[]>('pending-image-prop-ids', () => [])
  const pendingImageAssetsUpdatedAt = useState<number>('pending-image-assets-updated-at', () => 0)
  const pendingImageAssetsHydrated = useState<boolean>('pending-image-assets-hydrated', () => false)

  if (import.meta.client && !pendingImageAssetsHydrated.value) {
    pendingImageAssetsHydrated.value = true
    try {
      const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null')
      if (saved && Date.now() - Number(saved.updatedAt || 0) < MAX_PENDING_AGE_MS) {
        pendingCharImageIds.value = Array.isArray(saved.characterIds) ? saved.characterIds : []
        pendingSceneImageIds.value = Array.isArray(saved.sceneIds) ? saved.sceneIds : []
        pendingPropImageIds.value = Array.isArray(saved.propIds) ? saved.propIds : []
        pendingImageAssetsUpdatedAt.value = Number(saved.updatedAt || Date.now())
      } else {
        sessionStorage.removeItem(STORAGE_KEY)
      }
    } catch {
      sessionStorage.removeItem(STORAGE_KEY)
    }
  }

  if (import.meta.client) {
    watch([pendingCharImageIds, pendingSceneImageIds, pendingPropImageIds], () => {
      const hasPending = pendingCharImageIds.value.length || pendingSceneImageIds.value.length || pendingPropImageIds.value.length
      if (!hasPending) {
        pendingImageAssetsUpdatedAt.value = 0
        sessionStorage.removeItem(STORAGE_KEY)
        return
      }
      pendingImageAssetsUpdatedAt.value = Date.now()
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
        characterIds: pendingCharImageIds.value,
        sceneIds: pendingSceneImageIds.value,
        propIds: pendingPropImageIds.value,
        updatedAt: pendingImageAssetsUpdatedAt.value,
      }))
    }, { deep: true })
  }

  function pruneExpiredPendingImageAssets() {
    if (!pendingImageAssetsUpdatedAt.value || Date.now() - pendingImageAssetsUpdatedAt.value < MAX_PENDING_AGE_MS) return
    pendingCharImageIds.value = []
    pendingSceneImageIds.value = []
    pendingPropImageIds.value = []
  }

  return {
    pendingCharImageIds,
    pendingSceneImageIds,
    pendingPropImageIds,
    pruneExpiredPendingImageAssets,
  }
}
