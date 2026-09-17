import { AppShell } from '@/components/app-shell';

/**
 * The only entry point. Visitors always land in the typing game; the messaging
 * interface is reached by typing the secret code and authenticating.
 */
export default function HomePage() {
  return <AppShell />;
}
