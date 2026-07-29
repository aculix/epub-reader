import { Routes, Route } from 'react-router-dom';
import { MotionConfig } from 'motion/react';
import LibraryPage from './pages/LibraryPage';
import ReaderPage from './pages/ReaderPage';

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <Routes>
        <Route path="/" element={<LibraryPage />} />
        <Route path="/read/:id" element={<ReaderPage />} />
      </Routes>
    </MotionConfig>
  );
}
