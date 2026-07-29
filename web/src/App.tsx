import { Routes, Route } from 'react-router-dom';
import LibraryPage from './pages/LibraryPage';
import ReaderPage from './pages/ReaderPage';
import { ThemeContext, useTheme } from './lib/theme';

export default function App() {
  const themeState = useTheme();
  return (
    <ThemeContext.Provider value={themeState}>
      <Routes>
        <Route path="/" element={<LibraryPage />} />
        <Route path="/read/:id" element={<ReaderPage />} />
      </Routes>
    </ThemeContext.Provider>
  );
}
