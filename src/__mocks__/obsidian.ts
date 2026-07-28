interface MockRequestParams {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** Minimal requestUrl bridge for unit tests that already stub global fetch. */
export async function requestUrl(params: MockRequestParams): Promise<{
  status: number;
  text: string;
  json: unknown;
}> {
  const response = await fetch(params.url, {
    method: params.method,
    headers: params.headers,
    body: params.body,
  });
  const responseWithBody = response as Response & {
    text?: () => Promise<string>;
    json?: () => Promise<unknown>;
  };
  const text = responseWithBody.text ? await responseWithBody.text() : '';
  let json: unknown;
  if (responseWithBody.json) {
    json = await responseWithBody.json();
  } else if (text) {
    json = JSON.parse(text) as unknown;
  }
  return { status: response.status, text, json };
}
