import { motion } from 'motion/react';
import { IconUpload } from '../Icons';

export default function DropOverlay() {
  return (
    <motion.div
      className="drop-overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
    >
      <motion.div
        className="drop-overlay-panel"
        initial={{ scale: 0.94, y: 10 }}
        animate={{ scale: 1, y: 0 }}
        transition={{ duration: 0.3, ease: [0.34, 1.4, 0.64, 1] }}
      >
        <IconUpload />
        <h2>Drop books to add them</h2>
        <p>ePUB and PDF files</p>
      </motion.div>
    </motion.div>
  );
}
