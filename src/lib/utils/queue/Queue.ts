import type { Guild, GuildMember, TextChannel, VoiceChannel } from 'discord.js';
import { Song } from './Song';
import type { Track } from '@lavaclient/types';
import { DiscordResource, getId, Player, Snowflake } from 'lavaclient';
import { container } from '@sapphire/framework';
import type { QueueStore } from './QueueStore';
import { Time } from '@sapphire/time-utilities';
import { isNullish } from '@sapphire/utilities';

export enum LoopType {
  None,
  Queue,
  Song
}

const kExpireTime = Time.Day * 2;

export interface QueueEvents {
  trackStart: (song: Song) => void;
  trackEnd: (song: Song) => void;
  finish: () => void;
}

export interface Loop {
  type: LoopType;
  current: number;
  max: number;
}

export interface AddOptions {
  requester?: Snowflake | DiscordResource;
  userInfo?: GuildMember;
  added?: number;
  next?: boolean;
}

export type Addable = string | Track | Song;

interface NowPlaying {
  song: Song;
  position: number;
}

interface QueueKeys {
  readonly next: string;
  readonly position: string;
  readonly current: string;
  readonly skips: string;
  readonly systemPause: string;
  readonly replay: string;
  readonly volume: string;
  readonly text: string;
}

export class Queue {
  public readonly keys: QueueKeys;
  private skipped: boolean;

  public constructor(
    public readonly store: QueueStore,
    public readonly guildID: string
  ) {
    this.keys = {
      current: `music.${this.guildID}.current`,
      next: `music.${this.guildID}.next`,
      position: `music.${this.guildID}.position`,
      skips: `music.${this.guildID}.skips`,
      systemPause: `music.${this.guildID}.systemPause`,
      replay: `music.${this.guildID}.replay`,
      volume: `music.${this.guildID}.volume`,
      text: `music.${this.guildID}.text`
    };

    this.skipped = false;
  }

  public get client() {
    return container.client;
  }

  public get player(): Player {
    return this.store.client.players.get(this.guildID)!;
  }

  public get playing(): boolean {
    return this.player.playing;
  }

  public get paused(): boolean {
    return this.player.paused;
  }

  public get guild(): Guild {
    return this.client.guilds.cache.get(this.guildID) as Guild;
  }

  public get voiceChannel(): VoiceChannel | null {
    const id = this.voiceChannelID;
    return id
      ? (this.guild.channels.cache.get(id) as VoiceChannel) ?? null
      : null;
  }

  public get voiceChannelID(): string | null {
    if (!this.player) return null;
    return this.player.channelId ?? null;
  }

  public createPlayer(): Player {
    let player = this.player;
    if (!player) {
      player = this.store.client.createPlayer(this.guildID);
      player.on('trackEnd', async () => {
        if (!this.skipped) {
          await this.next();
        }
        this.skipped = false;
      });
    }
    return player;
  }

  public destroyPlayer(): void {
    if (this.player) {
      this.store.client.destroyPlayer(this.guildID);
    }
  }

  // Start the queue
  public async start(replaying = false): Promise<boolean> {
    const np = await this.nowPlaying();
    if (!np) return this.next();

    await this.player.play(np.song as Song);

    this.client.emit(
      replaying ? 'musicSongReplay' : 'musicSongPlay',
      this,
      np.song as Song
    );
    return true;
  }

  // Returns whether or not there are songs that can be played
  public async canStart(): Promise<boolean> {
    return (
      (await this.store.redis.exists(this.keys.current, this.keys.next)) > 0
    );
  }

  // add tracks to queue
  public async add(
    songs: Addable | Array<Addable>,
    options: AddOptions = {}
  ): Promise<number> {
    songs = Array.isArray(songs) ? songs : [songs];
    if (!songs.length) return 0;

    const requesterId = options.requester && getId(options.requester);
    const user = options.userInfo;
    const added = Date.now();
    const toAdd = songs.map(song =>
      song instanceof Song
        ? song
        : new Song(song, added, {
            avatar: user?.user.avatar,
            defaultAvatarURL: user?.user.defaultAvatarURL,
            id: requesterId,
            name: user?.nickname ?? user?.user.username
          })
    );

    await this.store.redis.lpush(
      this.keys.next,
      ...toAdd.map(song => this.stringifySong(song))
    );
    await this.refresh();
    this.client.emit('musicQueueSync', this);
    return songs.length;
  }

  public async pause({ system = false } = {}) {
    await this.player.pause(true);
    await this.setSystemPaused(system);
    this.client.emit('musicSongPause', this);
  }

  public async resume() {
    await this.player.pause(false);
    await this.setSystemPaused(false);
    this.client.emit('musicSongResume', this);
  }

  /*
  resetSkipVotes, addSkipVote
*/

  public getSystemPaused(): Promise<boolean> {
    return this.store.redis.get(this.keys.systemPause).then(d => d === '1');
  }

  public async setSystemPaused(value: boolean): Promise<boolean> {
    await this.store.redis.set(this.keys.systemPause, value ? '1' : '0');
    await this.refresh();
    this.client.emit('musicSongPause', this, value);
    return value;
  }

  /**
   * Retrieves whether or not the system should repeat the current track.
   */
  public getReplay(): Promise<boolean> {
    return this.store.redis.get(this.keys.replay).then(d => d === '1');
  }

  public async setReplay(value: boolean): Promise<boolean> {
    await this.store.redis.set(this.keys.replay, value ? '1' : '0');
    await this.refresh();
    this.client.emit('musicReplayUpdate', this, value);
    return value;
  }

  /**
   * Retrieves the volume of the track in the queue.
   */

  public async getVolume(): Promise<number> {
    const raw = await this.store.redis.get(this.keys.volume);
    return raw ? Number(raw) : 100;
  }

  // set the volume of the track in the queue
  public async setVolume(
    value: number
  ): Promise<{ previous: number; next: number }> {
    await this.player.setVolume(value);
    const previous = await this.store.redis.getset(this.keys.volume, value);
    await this.refresh();

    this.client.emit('musicSongVolumeUpdate', this, value);
    return {
      previous: previous === null ? 100 : Number(previous),
      next: value
    };
  }

  public async seek(position: number): Promise<void> {
    await this.player.seek(position);
    this.client.emit('musicSongSeekUpdate', this, position);
  }

  // connect to a voice channel
  public async connect(channelID: string): Promise<void> {
    await this.player.connect(channelID, { deafened: true });
  }

  // leave the voice channel
  public async leave(): Promise<void> {
    await this.player.disconnect();
    await this.setTextChannelID(null);
  }

  public async getTextChannel(): Promise<TextChannel | null> {
    const id = await this.getTextChannelID();
    if (id === null) return null;

    const channel = this.guild.channels.cache.get(id) ?? null;
    if (channel === null) {
      await this.setTextChannelID(null);
      return null;
    }

    return channel as TextChannel;
  }

  public getTextChannelID(): Promise<string | null> {
    return this.store.redis.get(this.keys.text);
  }

  public setTextChannelID(channelID: null): Promise<null>;

  public async setTextChannelID(channelID: string): Promise<string>;
  public async setTextChannelID(
    channelID: string | null
  ): Promise<string | null> {
    if (channelID === null) {
      await this.store.redis.del(this.keys.text);
    } else {
      await this.store.redis.set(this.keys.text, channelID);
      await this.refresh();
    }

    return channelID;
  }

  public async getCurrentTrack(): Promise<Song | null> {
    const value = await this.store.redis.get(this.keys.current);
    return value ? this.parseSongString(value) : null;
  }

  public async getAt(index: number): Promise<Addable | null> {
    const value = await this.store.redis.lindex(this.keys.next, -index - 1);
    return value ? this.parseSongString(value) : null;
  }

  public async removeAt(position: number): Promise<void> {
    await this.store.redis.lremat(this.keys.next, -position - 1);
    await this.refresh();
    this.client.emit('musicQueueSync', this);
  }

  public async next({ skipped = false } = {}): Promise<boolean> {
    if (skipped) this.skipped = true;
    // Sets the current position to 0.
    await this.store.redis.del(this.keys.position);

    // Get whether or not the queue is on replay mode.
    const replaying = await this.getReplay();

    // If not skipped (song ended) and is replaying, replay.
    if (!skipped && replaying) {
      return this.start(true);
    }

    // If it was skipped, set replay back to false.
    if (replaying) await this.setReplay(false);

    // Removes the next entry from the list and sets it as the current track.
    const entry = await this.store.redis.rpopset(
      this.keys.next,
      this.keys.current
    );
    // If there was an entry to play, refresh the state and start playing.
    if (entry) {
      await this.refresh();
      return this.start(false);
    }
    this.client.emit('musicFinish', this);
    return false;
  }

  public count(): Promise<number> {
    return this.store.redis.llen(this.keys.next);
  }

  public async moveTracks(from: number, to: number): Promise<void> {
    await this.store.redis.lmove(this.keys.next, -from - 1, -to - 1); // work from the end of the list, since it's reversed
    await this.refresh();
    this.client.emit('musicQueueSync', this);
  }

  public async shuffleTracks(): Promise<void> {
    await this.store.redis.lshuffle(this.keys.next, Date.now());
    await this.refresh();
    this.client.emit('musicQueueSync', this);
  }

  public async stop(): Promise<void> {
    await this.player.stop();
  }

  public async clearTracks(): Promise<void> {
    await this.store.redis.del(this.keys.next);
    this.client.emit('musicQueueSync', this);
  }

  public refresh() {
    return this.store.redis
      .pipeline()
      .pexpire(this.keys.next, kExpireTime)
      .pexpire(this.keys.position, kExpireTime)
      .pexpire(this.keys.current, kExpireTime)
      .pexpire(this.keys.skips, kExpireTime)
      .pexpire(this.keys.systemPause, kExpireTime)
      .pexpire(this.keys.replay, kExpireTime)
      .pexpire(this.keys.volume, kExpireTime)
      .pexpire(this.keys.text, kExpireTime)
      .exec();
  }

  public clear(): Promise<number> {
    return this.store.redis.del(
      this.keys.next,
      this.keys.position,
      this.keys.current,
      this.keys.skips,
      this.keys.systemPause,
      this.keys.replay,
      this.keys.volume,
      this.keys.text
    );
  }

  public async nowPlaying(): Promise<NowPlaying | null> {
    const [entry, position] = await Promise.all([
      this.getCurrentTrack(),
      this.store.redis.get(this.keys.position)
    ]);
    if (entry === null) return null;

    return {
      song: entry,
      position: isNullish(position) ? 0 : parseInt(position, 10)
    };
  }

  public async tracks(start = 0, end = -1): Promise<Addable[]> {
    if (end === Infinity) end = -1;

    const tracks = await this.store.redis.lrange(this.keys.next, start, end);
    return [...tracks].map(this.parseSongString);
  }

  public stringifySong(song: Song): string {
    return JSON.stringify(song);
  }

  public parseSongString(song: string): Song {
    return JSON.parse(song);
  }
}
