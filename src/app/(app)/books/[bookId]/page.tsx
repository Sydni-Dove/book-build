import { redirect } from 'next/navigation';

export default function BookIndexPage({ params }: { params: { bookId: string } }) {
  redirect(`/books/${params.bookId}/chapters`);
}
