import { useEffect } from 'react'
import { Outlet } from 'react-router'
import { useWebSocket } from '@/ws/useWebSocket'
import { useStore } from '@/store'
import { useThemeApplicator } from '@/hooks/useThemeApplicator'
import { useCharacterTheme } from '@/hooks/useCharacterTheme'
import { useAppInit } from '@/hooks/useAppInit'
import ErrorBoundary from '@/components/shared/ErrorBoundary'
import AuthGuard from '@/components/auth/AuthGuard'
import ViewportDrawer from '@/components/panels/ViewportDrawer'
import ModalContainer from '@/components/modals/ModalContainer'
import SpindleUIManager from '@/components/spindle/SpindleUIManager'
import ToastContainer from '@/components/shared/ToastContainer'
import styles from './App.module.css'

export default function App() {
  useWebSocket()
  useThemeApplicator()
  useCharacterTheme()
  useAppInit()

  const loadSettings = useStore((s) => s.loadSettings)
  const isAuthenticated = useStore((s) => s.isAuthenticated)
  useEffect(() => {
    if (isAuthenticated) {
      loadSettings()
    }
  }, [isAuthenticated, loadSettings])

  // Global Cmd+K / Ctrl+K shortcut to open the command palette
  const openCommandPalette = useStore((s) => s.openCommandPalette)
  const closeCommandPalette = useStore((s) => s.closeCommandPalette)
  const commandPaletteOpen = useStore((s) => s.commandPaletteOpen)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        if (commandPaletteOpen) {
          closeCommandPalette()
        } else {
          openCommandPalette()
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [commandPaletteOpen, openCommandPalette, closeCommandPalette])

  // Apply modal-width mode as a root CSS variable so all modals can reference it
  const modalWidthMode = useStore((s) => s.modalWidthMode)
  const modalMaxWidth = useStore((s) => s.modalMaxWidth)
  useEffect(() => {
    const root = document.documentElement
    switch (modalWidthMode) {
      case 'comfortable':
        root.style.setProperty('--lumiverse-content-max-width', '1000px')
        break
      case 'compact':
        root.style.setProperty('--lumiverse-content-max-width', '760px')
        break
      case 'custom':
        root.style.setProperty('--lumiverse-content-max-width', `${modalMaxWidth}px`)
        break
      default:
        root.style.removeProperty('--lumiverse-content-max-width')
    }
  }, [modalWidthMode, modalMaxWidth])

  return (
    <AuthGuard>
      <div className={styles.app}>
        <ErrorBoundary label="App">
          <main className={styles.main}>
            <Outlet />
          </main>
          <ViewportDrawer />
          <ModalContainer />
          <SpindleUIManager />
          <ToastContainer />
        </ErrorBoundary>
      </div>
    </AuthGuard>
  )
}
