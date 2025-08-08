import React from "react";
import { ReactiveStore } from "@luna/core";
import { LunaSettings, LunaSwitchSetting } from "@luna/ui";

export const storage = await ReactiveStore.getPluginStorage("MusicVideoButton", {
  seekOnSwitch: false
});

export const Settings = () => {
  const [seekOnSwitch, setSeekOnSwitch] = React.useState<boolean>(storage.seekOnSwitch);

  return (
    <LunaSettings>
      <LunaSwitchSetting
        {...({
          title: "Resume position when switching",
          desc: "If enabled, the player will resume from the same position when switching between tracks and videos. (Audio doesn't necessarily match up)",
          checked: seekOnSwitch,
          onChange: (_: React.ChangeEvent<HTMLInputElement>, checked: boolean) => {
            setSeekOnSwitch((storage.seekOnSwitch = checked));
          },
        } as any)}
      />
    </LunaSettings>
  );
};