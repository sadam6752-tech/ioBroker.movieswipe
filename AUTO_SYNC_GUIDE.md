# Auto Sync Guide

## Overview

The MovieSwipe adapter now supports automatic synchronization with intelligent API key management. This guide explains how the auto sync feature works and how to configure it properly.

## Configuration

### General Settings
- **Port**: Web server port (default: 3000)
- **API Keys**: Add one or more Kinopoisk API keys

### Synchronization Settings

#### Content Filters
- **Minimum Rating**: Minimum Kinopoisk rating (0-10, default: 5.0)
- **Minimum Votes**: Minimum number of votes for popularity (default: 500)
- **Year Range**: Start and end years for movie search

#### Advanced Settings
- **Max Requests per Run**: Maximum API requests per synchronization run
  - Default: 250 (free tier limit)
  - Can be set up to 1000 for premium keys
  - This is the maximum requests in a single sync session

- **Daily Request Limit**: Total API requests allowed per day
  - Default: 250 (free tier limit)
  - Can be higher for premium keys (e.g., 500, 1000)
  - This is the total daily quota across all sync runs

- **Auto Sync**: Enable automatic synchronization
  - When enabled, sync runs automatically at specified intervals
  - First sync runs immediately on adapter start
  - Subsequent syncs run at the specified interval

- **Sync Interval**: Time between automatic synchronizations
  - Default: 24 hours
  - Only visible when Auto Sync is enabled
  - Minimum: 1 hour, Maximum: 168 hours (1 week)

## How Auto Sync Works

### Single API Key
If you have one API key:
1. Adapter starts → Auto sync runs immediately
2. Sync completes → Progress saved with timestamp
3. After 24 hours (or configured interval) → Auto sync runs again
4. If daily limit reached → Auto sync waits until next day

### Multiple API Keys
If you have multiple API keys:
1. Adapter starts → Auto sync runs with first available key
2. Sync completes → Key marked with cooldown timestamp
3. After interval → Auto sync finds next available key (not on cooldown)
4. If all keys on cooldown → Auto sync waits until one becomes available

### Cooldown Tracking
Each API key has its own cooldown timer:
- When a key completes a sync, it's marked with current timestamp
- Auto sync won't use that key again until `Sync Interval` has passed
- This prevents hitting daily limits with the same key

### Example with 2 Keys and 24-hour Interval
```
Day 1, 10:00 AM:
  - Adapter starts
  - Auto sync runs with Key 1
  - Sync completes at 10:15 AM
  - Key 1 marked with cooldown until Day 2, 10:15 AM

Day 2, 10:15 AM:
  - Auto sync runs with Key 2 (Key 1 still on cooldown)
  - Sync completes at 10:30 AM
  - Key 2 marked with cooldown until Day 3, 10:30 AM

Day 2, 10:15 AM (after Key 1 cooldown expires):
  - Auto sync can use Key 1 again
  - But Key 2 is already running, so waits for next interval
```

## Request Limits

### Free Tier (Default)
- Daily Limit: 250 requests/day
- Max Requests per Run: 250
- This means you can do one full sync per day

### Premium Tier
- Daily Limit: 500-1000+ requests/day (depends on plan)
- Max Requests per Run: 500-1000+ (depends on plan)
- With multiple keys, you can do multiple syncs per day

## Rate Limit Handling

The adapter automatically handles API rate limits:

1. **HTTP 429 Error**: When API returns rate limit error
   - Sync stops gracefully
   - All found movies are saved
   - Progress is saved for next run
   - Adapter waits for next sync interval

2. **Daily Limit Reached**: When daily request quota is exhausted
   - Sync stops gracefully
   - With multiple keys, tries next available key
   - If all keys exhausted, waits until next day

3. **Progress Persistence**: Sync progress is saved in `www/data/.sync-progress.json`
   - Persists across adapter restarts
   - Persists across reinstalls
   - Each API key has separate progress tracking

## Best Practices

### Single Key Setup
- Set Daily Limit to 250 (free tier)
- Set Max Requests per Run to 250
- Set Sync Interval to 24 hours
- Auto sync will run once per day

### Multiple Keys Setup (2 keys)
- Set Daily Limit to 250 per key
- Set Max Requests per Run to 250
- Set Sync Interval to 12 hours
- Auto sync will alternate between keys every 12 hours

### Multiple Keys Setup (3+ keys)
- Set Daily Limit to 250 per key
- Set Max Requests per Run to 250
- Set Sync Interval to 8 hours (for 3 keys)
- Auto sync will rotate through keys

### Premium Keys
- Set Daily Limit to your actual limit (e.g., 500, 1000)
- Set Max Requests per Run to your actual limit
- Set Sync Interval based on your needs
- Can do multiple syncs per day

## Monitoring

Check these states to monitor auto sync:

- `sync.status`: Current sync status (idle, running, completed, error)
- `sync.progress`: Sync progress percentage (0-100)
- `sync.foundMovies`: Movies found in current sync session
- `sync.totalMovies`: Total movies in database
- `sync.lastSync`: Timestamp of last successful sync
- `sync.error`: Error message if sync failed
- `sync.requestsUsed`: API requests used in current sync
- `sync.requestsRemaining`: API requests remaining today

## Troubleshooting

### Auto Sync Not Running
- Check if Auto Sync is enabled in settings
- Check adapter logs for errors
- Verify API keys are configured and valid
- Check if all keys are on cooldown

### Sync Stops with Rate Limit Error
- This is normal - adapter is respecting API limits
- Check Daily Request Limit setting
- If using free tier, limit is 250/day
- Wait until next sync interval or next day

### Progress Not Saving
- Check if `www/data/` directory exists and is writable
- Check adapter logs for file write errors
- Verify adapter has proper permissions

### Movies Not Appearing in App
- After sync completes, refresh app (F5) to clear cache
- Check `sync.totalMovies` state to verify movies were added
- Check app logs for any errors

## API Key Management

### Getting API Keys
1. Visit https://api.kinopoisk.dev/
2. Register and get your free API key
3. Add key to adapter settings
4. For premium keys, contact Kinopoisk support

### Adding Multiple Keys
1. Go to adapter settings → General Settings
2. Click '+' button in API Keys table
3. Paste your API key
4. Click Save
5. Adapter will automatically rotate between keys

### Removing Keys
1. Go to adapter settings → General Settings
2. Click '-' button next to the key you want to remove
3. Click Save

## Advanced Configuration

### Manual Sync
You can still trigger manual sync even with Auto Sync enabled:
1. Go to adapter objects
2. Find `movieswipe.0.sync.start`
3. Set to `true` to start sync
4. Set `movieswipe.0.sync.stop` to `true` to stop

### Resetting Progress
To reset sync progress and start from beginning:
1. Stop the adapter
2. Delete `www/data/.sync-progress.json`
3. Start the adapter
4. Auto sync will start fresh

### Custom Sync Script
You can also run the sync script manually:
```bash
cd iobroker.movieswipe/scripts
node poiskkino-sync.cjs --api-key YOUR_KEY --max-requests 50 --daily-limit 250
```

## Version History

- **v1.0.7**: Auto sync with smart API key rotation
- **v1.0.6**: API rate limit detection
- **v1.0.5**: Config parameters support
- **v1.0.4**: Graceful shutdown handling
- **v1.0.3**: Progress tracking improvements
- **v1.0.2**: App reload signal
- **v1.0.1**: Sync output directory fix
- **v1.0.0**: Initial release
