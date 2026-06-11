export async function checkIfLiveDirectly(identifier: string): Promise<boolean> {
  try {
    const response = await fetch('/api/check-live', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ identifier })
    });
    if (!response.ok) return false;
    
    const data = await response.json();
    return data.isLive === true;
  } catch (e) {
    console.error("Direct live check failed:", e);
    return false;
  }
}
