import { RequireAccess } from '@/components/require-access';

export default function AuthenticatedLayout({ children }: { children: React.ReactNode }) {
  return <RequireAccess>{children}</RequireAccess>;
}
