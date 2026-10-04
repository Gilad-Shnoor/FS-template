import type { Todo } from '@app/contracts/api';
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { Button, Card, ErrorText, Input } from '@/components/ui';
import { api, errorMessage, queries } from '@/lib/api';

export const Route = createFileRoute('/_authed/todos')({
  loader: ({ context }) => context.queryClient.ensureQueryData(queries.todos()),
  component: Todos,
});

function Todos() {
  const { data } = useSuspenseQuery(queries.todos());
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const invalidate = () => queryClient.invalidateQueries({ queryKey: queries.todos().queryKey });

  const create = useMutation({
    mutationFn: (t: string) => api.createTodo({ body: { title: t } }),
    onSuccess: () => {
      setTitle('');
      return invalidate();
    },
  });
  const toggle = useMutation({
    mutationFn: (todo: Todo) => api.updateTodo({ params: { id: todo.id }, body: { completed: !todo.completed } }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteTodo({ params: { id } }),
    onSuccess: invalidate,
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (title.trim()) create.mutate(title);
  };

  const done = data.items.filter((t) => t.completed).length;

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Todos</h1>
        <span className="text-sm text-zinc-500">
          {done}/{data.items.length} done
        </span>
      </div>

      <Card className="space-y-4">
        <form onSubmit={onSubmit} className="flex gap-2">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing?" aria-label="New todo" />
          <Button type="submit" disabled={create.isPending || !title.trim()}>
            Add
          </Button>
        </form>
        <ErrorText>{create.error && errorMessage(create.error)}</ErrorText>

        {data.items.length === 0 ? (
          <p className="py-6 text-center text-sm text-zinc-500">Nothing here yet.</p>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {data.items.map((todo) => (
              <li key={todo.id} className="group flex items-center gap-3 py-2.5">
                <input
                  type="checkbox"
                  checked={todo.completed}
                  onChange={() => toggle.mutate(todo)}
                  className="size-4 accent-zinc-900 dark:accent-white"
                  aria-label={`Mark "${todo.title}" ${todo.completed ? 'not done' : 'done'}`}
                />
                <span className={`flex-1 text-sm ${todo.completed ? 'text-zinc-400 line-through' : ''}`}>{todo.title}</span>
                <Button
                  variant="danger"
                  className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={() => remove.mutate(todo.id)}
                  aria-label={`Delete "${todo.title}"`}
                >
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
