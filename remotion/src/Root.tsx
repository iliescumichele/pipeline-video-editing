import { Composition } from 'remotion';
import { defaultMontageProps, type MontageProps, NewsMontage } from './NewsMontage';
import { defaultProps, Short, type ShortProps } from './Short';
import { defaultStoryProps, StoryShort, type StoryProps } from './StoryShort';

export const Root: React.FC = () => (
  <>
  <Composition
    id="Short"
    component={Short}
    width={1080}
    height={1920}
    fps={60}
    durationInFrames={60 * 35}
    defaultProps={defaultProps}
    calculateMetadata={({ props }: { props: ShortProps }) => ({ fps: props.fps, durationInFrames: Math.round(props.duration * props.fps) })}
  />
  <Composition
    id="StoryShort"
    component={StoryShort}
    width={1080}
    height={1920}
    fps={60}
    durationInFrames={600}
    defaultProps={defaultStoryProps}
    calculateMetadata={({ props }: { props: StoryProps }) => ({ fps: props.fps, durationInFrames: Math.round(props.duration * props.fps) })}
  />
  <Composition
    id="NewsMontage"
    component={NewsMontage}
    width={3840}
    height={2160}
    fps={30}
    durationInFrames={90}
    defaultProps={defaultMontageProps}
    calculateMetadata={({ props }: { props: MontageProps }) => ({ fps: props.fps, width: props.width, height: props.height, durationInFrames: props.duration })}
  />
  </>
);
