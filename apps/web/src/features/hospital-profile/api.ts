import { api, requireData } from '@/shared/api';
import { hospitalProfileSchema } from './schemas';
import type { HospitalProfile, HospitalProfileUpdate } from './types';

export async function fetchHospitalProfile(signal?: AbortSignal): Promise<HospitalProfile> {
  const result = await api.GET('/hospital-profile', { signal });
  return hospitalProfileSchema.parse(requireData(result));
}

export async function updateHospitalProfile(body: HospitalProfileUpdate): Promise<HospitalProfile> {
  const result = await api.PATCH('/hospital-profile', { body });
  return hospitalProfileSchema.parse(requireData(result));
}
