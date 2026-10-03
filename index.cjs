const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder
} = require('discord.js');

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType
} = require('@discordjs/voice');

const { spawn } = require('child_process');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ]
});

const player = createAudioPlayer({
  behaviors: {
    noSubscriber: NoSubscriberBehavior.Pause
  }
});

const connections = new Map();

let currentProcess = null;
let currentSearch = null;

const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Search YouTube and play a song')
    .addStringOption(option =>
      option
        .setName('song')
        .setDescription('Song name')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop music'),

  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Leave voice channel')
];

function stopYouTubeProcess() {
  if (currentProcess) {
    try {
      currentProcess.kill('SIGKILL');
    } catch {}

    currentProcess = null;
  }
}

function searchYouTube(song) {
  return new Promise((resolve, reject) => {
    console.log(`🔎 Searching YouTube: ${song}`);

    const search = spawn(
      'python',
      [
        '-m',
        'yt_dlp',
        '--flat-playlist',
        '--playlist-end',
        '1',
        `ytsearch1:${song}`,
        '--print',
        '%(webpage_url)s'
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );

    let output = '';
    let errorOutput = '';

    search.stdout.on('data', data => {
      output += data.toString();
    });

    search.stderr.on('data', data => {
      errorOutput += data.toString();
    });

    search.on('close', code => {
      const url = output.trim().split('\n').find(line =>
        line.startsWith('http')
      );

      if (url) {
        console.log(`✅ Found: ${url}`);
        resolve(url);
      } else {
        console.error(errorOutput);
        reject(new Error('Song not found'));
      }
    });
  });
}

function playYouTube(url) {
  stopYouTubeProcess();

  console.log('🎵 Starting YouTube...');

  const ytdlp = spawn(
    'python',
    [
      '-m',
      'yt_dlp',
      '--no-playlist',
      '-f',
      'bestaudio',
      '-o',
      '-',
      url
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );

  currentProcess = ytdlp;

  ytdlp.stderr.on('data', data => {
    const text = data.toString().trim();

    if (text) {
      console.log('yt-dlp:', text);
    }
  });

  const ffmpeg = spawn(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-f',
      's16le',
      '-ar',
      '48000',
      '-ac',
      '2',
      'pipe:1'
    ],
    {
      stdio: ['pipe', 'pipe', 'pipe']
    }
  );

  ytdlp.stdout.pipe(ffmpeg.stdin);

  ffmpeg.stderr.on('data', data => {
    const text = data.toString().trim();

    if (text) {
      console.error('FFmpeg:', text);
    }
  });

  ffmpeg.on('close', code => {
    console.log(`FFmpeg ended: ${code}`);

    if (currentProcess === ytdlp) {
      currentProcess = null;
    }
  });

  ytdlp.on('error', error => {
    console.error('yt-dlp ERROR:', error);
  });

  const resource = createAudioResource(ffmpeg.stdout, {
    inputType: StreamType.Raw
  });

  player.play(resource);

  console.log('▶️ Playing YouTube song...');
}

function connectToChannel(channel) {
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false
  });

  connection.subscribe(player);

  connections.set(channel.guild.id, {
    channelId: channel.id,
    connection
  });

  return connection;
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const rest = new REST({ version: '10' })
    .setToken(process.env.DISCORD_TOKEN);

  await rest.put(
    Routes.applicationCommands(client.user.id),
    { body: [] }
  );

  for (const guild of client.guilds.cache.values()) {
    await rest.put(
      Routes.applicationGuildCommands(
        client.user.id,
        guild.id
      ),
      {
        body: commands.map(command => command.toJSON())
      }
    );

    console.log(`Commands registered in: ${guild.name}`);
  }

  console.log('✅ Bot ready!');
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'play') {
    await interaction.deferReply();

    const channel = interaction.member.voice.channel;
    const song = interaction.options.getString('song');

    if (!channel) {
      return interaction.editReply(
        '❌ ആദ്യം ഒരു voice channel-ൽ join ചെയ്യൂ.'
      );
    }

    try {
      connectToChannel(channel);

      currentSearch = song;

      const url = await searchYouTube(song);

      playYouTube(url);

      return interaction.editReply(
        `🎵 **${song}**\n▶️ Playing now!`
      );
    } catch (error) {
      console.error('PLAY ERROR:', error);

      return interaction.editReply(
        '❌ Song കണ്ടെത്താൻ കഴിഞ്ഞില്ല.'
      );
    }
  }

  if (interaction.commandName === 'stop') {
    stopYouTubeProcess();
    player.stop();

    return interaction.reply(
      '⏹️ Music stopped.'
    );
  }

  if (interaction.commandName === 'leave') {
    stopYouTubeProcess();
    player.stop();

    const saved = connections.get(interaction.guild.id);

    if (saved) {
      saved.connection.destroy();
      connections.delete(interaction.guild.id);
    }

    return interaction.reply(
      '👋 Voice channel വിട്ടു.'
    );
  }
});

client.login(process.env.DISCORD_TOKEN);
