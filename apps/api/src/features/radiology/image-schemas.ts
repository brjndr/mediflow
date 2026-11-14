import { Type, type Static } from '@sinclair/typebox';
import { CursorPage, StringEnum, ref } from '../../core/http/schemas.js';
import { PLAIN_TEXT } from '../../core/http/text.js';

/** The ceiling of one file; a CT or MR series is sent as a PDF report or several files. */
export const IMAGE_MAX_BYTES = 25 * 1024 * 1024;
export const IMAGES_PER_STUDY = 50;
export const UPLOAD_TTL_SECONDS = 900;

/** The types accepted; the file received must also begin as its type does. */
export const IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'application/pdf',
  'application/dicom',
] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

export const IMAGE_STATUSES = ['pending', 'scanning', 'clean', 'infected', 'failed'] as const;

export const ImagingImageCreate = Type.Object(
  {
    fileName: Type.String({ minLength: 1, maxLength: 200, pattern: PLAIN_TEXT }),
    contentType: Type.String({
      description: `One of ${IMAGE_TYPES.join(', ')} (422 \`file_type_not_allowed\`).`,
    }),
    size: Type.Integer({
      minimum: 1,
      description: `The size in bytes, at most ${IMAGE_MAX_BYTES} (422 \`file_too_large\`).`,
    }),
  },
  { $id: 'ImagingImageCreate', additionalProperties: false },
);
export type ImagingImageCreate = Static<typeof ImagingImageCreate>;

export const ImagingImage = Type.Object(
  {
    id: Type.String(),
    studyId: Type.String(),
    fileName: Type.String(),
    contentType: Type.String(),
    size: Type.Integer(),
    status: StringEnum(IMAGE_STATUSES, {
      description:
        'pending: nothing received yet. scanning: received, waiting for the malware scan. clean: may be downloaded. infected: the scan found something and the file was deleted. failed: the file was lost or could not be scanned.',
    }),
    createdAt: Type.String({ format: 'date-time' }),
    uploadedAt: Type.Optional(Type.String({ format: 'date-time' })),
  },
  { $id: 'ImagingImage', description: 'A file attached to a performed imaging study.' },
);
export type ImagingImage = Static<typeof ImagingImage>;

export const ImagingImageUpload = Type.Object(
  {
    image: ref(ImagingImage),
    uploadUrl: Type.String({
      description:
        'A signed, short-lived address to PUT the file to with the same Content-Type. The signature is the only credential.',
    }),
    direct: Type.Optional(
      Type.Boolean({
        description:
          'True when `uploadUrl` is the bucket itself: PUT the file there with the same Content-Type, then call `completeImagingImageUpload`.',
      }),
    ),
    expiresAt: Type.String({ format: 'date-time' }),
  },
  { $id: 'ImagingImageUpload' },
);

export const ImagingImagePage = CursorPage(ref(ImagingImage), { $id: 'ImagingImagePage' });

export const ImagingImageDownload = Type.Object(
  { url: Type.String(), expiresAt: Type.String({ format: 'date-time' }) },
  { $id: 'ImagingImageDownload' },
);

export const ImageParams = Type.Object({ imageId: Type.String({ format: 'uuid' }) });
export const SignedQuery = Type.Object({
  expires: Type.Integer({ minimum: 0 }),
  signature: Type.String({ minLength: 1, maxLength: 200 }),
});

export const IMAGE_SCHEMAS = [
  ImagingImage,
  ImagingImageCreate,
  ImagingImageUpload,
  ImagingImagePage,
  ImagingImageDownload,
] as const;
