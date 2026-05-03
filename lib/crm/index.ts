import { ServiceFusionProvider } from './service-fusion'
import type { CrmProvider } from './types'

export function getProvider(): CrmProvider {
  // Future: swap to ServiceTitanProvider here without touching any other file
  return new ServiceFusionProvider()
}

export type { CrmProvider, CrmTechnician, CrmJob } from './types'
