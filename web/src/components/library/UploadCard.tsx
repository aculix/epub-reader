import { motion } from 'motion/react';
import type { UploadItem } from './useUploads';
import { IconAlert, IconClose } from '../Icons';

const stageLabel: Record<UploadItem['stage'], string> = {
  preparing: 'Preparing…',
  uploading: 'Uploading',
  cataloguing: 'Fetching book info…',
  error: 'Upload failed',
};

export default function UploadCard({ item, onDismiss }: { item: UploadItem; onDismiss: () => void }) {
  const pct = Math.round(item.fraction * 100);
  return (
    <motion.article
      className={`book-card upload-card ${item.stage}`}
      layout
      initial={{ opacity: 0, y: 26, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="book-cover upload-cover">
        {item.stage === 'error' ? (
          <div className="upload-error-face">
            <IconAlert />
            <p>{item.error}</p>
            <button className="btn btn-ghost" onClick={onDismiss}><IconClose /> Dismiss</button>
          </div>
        ) : (
          <div className="upload-face">
            <div className="upload-spine-anim" aria-hidden>
              <span /><span /><span />
            </div>
            <div className="upload-progress-track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <motion.div
                className="upload-progress-fill"
                animate={{ width: item.stage === 'cataloguing' ? '100%' : `${pct}%` }}
                transition={{ ease: 'easeOut', duration: 0.25 }}
              />
            </div>
            <span className="upload-stage">
              {stageLabel[item.stage]}
              {item.stage === 'uploading' && ` · ${pct}%`}
            </span>
          </div>
        )}
      </div>
      <div className="book-meta">
        <div className="book-text">
          <span className="book-title">{item.displayTitle}</span>
          <span className="book-author">{item.fileName}</span>
        </div>
      </div>
    </motion.article>
  );
}
