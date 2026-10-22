// Guard both dispatch and continuation: async work already sent to a provider
// may finish after close, but must not restart playback or mutate call state.
export function guardEffect<T extends (...args: any[]) => Promise<any>>(
  assertActive: () => void,
  effect: T,
): T {
  return (async (...args: Parameters<T>) => {
    assertActive();
    const value = await effect(...args);
    assertActive();
    return value;
  }) as T;
}

export function guardDatabase<T extends object>(
  database: T,
  assertActive: () => void,
): T {
  const wrap = (value: any): any => {
    if (!value || (typeof value !== "object" && typeof value !== "function"))
      return value;
    return new Proxy(value, {
      get(target, key) {
        const member = Reflect.get(target, key, target);
        if (key === "then" && typeof member === "function") {
          return (
            resolve: (result: any) => void,
            reject: (error: unknown) => void,
          ) => {
            try {
              assertActive();
              return member.call(
                target,
                (result: any) => {
                  try {
                    assertActive();
                    resolve(result);
                  } catch (error) {
                    reject(error);
                  }
                },
                reject,
              );
            } catch (error) {
              reject(error);
            }
          };
        }
        if (typeof member === "function")
          return (...args: any[]) => {
            assertActive();
            return wrap(member.apply(target, args));
          };
        return wrap(member);
      },
    });
  };
  return wrap(database);
}
